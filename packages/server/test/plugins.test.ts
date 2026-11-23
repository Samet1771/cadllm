// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type PartDef } from '@cadllm/core';
import { Workspace } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import type { PluginManifest, PluginPermission } from '@cadllm/plugin-api';
import { PluginHost, type LoadedPlugin } from '@cadllm/plugins';
import type { InstalledPlugin, RegistryIndex, ResolvedRegistryVersion } from '@cadllm/registry';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/index.ts';
import { attachWebSocket, type PluginRegistryApi } from '../src/ws.ts';

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class WsRpcClient {
  readonly ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
  private notifications: RpcResponse[] = [];
  private waiters: ((msg: RpcResponse) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as RpcResponse;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } else {
        const w = this.waiters.shift();
        if (w) w(msg);
        else this.notifications.push(msg);
      }
    });
  }

  static connect(url: string): Promise<WsRpcClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new WsRpcClient(ws)));
      ws.once('error', err => reject(err));
    });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: msg => {
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result as T);
        },
        reject,
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  nextNotification(predicate: (m: RpcResponse) => boolean = () => true, timeoutMs = 3000): Promise<RpcResponse> {
    const idx = this.notifications.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(this.notifications.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for notification')), timeoutMs);
      const wait = (msg: RpcResponse) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        } else {
          this.notifications.push(msg);
          this.waiters.push(wait);
        }
      };
      this.waiters.push(wait);
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

class FakePluginHost extends PluginHost {
  private loaded = new Map<string, LoadedPlugin>();
  failingIds = new Set<string>();
  manifestsByDir = new Map<string, PluginManifest>();

  override load(dir: string, opts?: { grants?: PluginPermission[] }): LoadedPlugin {
    const manifest = this.manifestsByDir.get(dir);
    if (!manifest) throw new Error(`no manifest registered for ${dir}`);
    if (this.failingIds.has(manifest.id)) {
      throw new Error(`simulated load failure for ${manifest.id}`);
    }
    const grants = [...(opts?.grants ?? [])];
    const entry: LoadedPlugin = { manifest, dir, grants };
    this.loaded.set(manifest.id, entry);
    this.bumpRevision();
    return entry;
  }

  override unload(pluginId: string): boolean {
    const deleted = this.loaded.delete(pluginId);
    if (deleted) this.bumpRevision();
    return deleted;
  }

  override list(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  override parts(): PartDef[] {
    if (this.loaded.has('org.example.sensors')) {
      return [
        {
          id: 'ldr',
          name: 'LDR Photoresistor',
          summary: 'Light-dependent resistor',
          category: 'sensor',
          refPrefix: 'R',
          pins: [
            { id: '1', name: '1', type: 'passive' },
            { id: '2', name: '2', type: 'passive' },
          ],
        },
      ];
    }
    return [];
  }
}

describe('server plugins WebSocket RPC & MCP isolation', () => {
  const dirs: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  function makeTempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('never exposes plugin install/grant/remove/panel methods as MCP tools', async () => {
    const root = makeTempDir('cadllm-mcp-root-');
    const serveFileDir = makeTempDir('cadllm-mcp-state-');
    const srv: RunningServer = await startServer({
      port: 0,
      root,
      serveFileDir,
      uiDistDir: join(root, 'missing-ui'),
    });
    cleanups.push(() => srv.close());

    const mcpClient = new Client({ name: 'test-ai', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', srv.url));
    await mcpClient.connect(transport);
    cleanups.push(async () => {
      await transport.terminateSession().catch(() => {});
      await mcpClient.close();
    });

    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual([
      'project',
      'read',
      'edit',
      'find',
      'check',
      'sim',
      'layout',
      'render',
      'export',
      'history',
      'help',
      'ext',
    ]);
    for (const forbidden of [
      'plugins.list',
      'plugins.index',
      'plugins.install',
      'plugins.grant',
      'plugins.revoke',
      'plugins.remove',
      'plugins.panel',
      'plugins.panelEdit',
    ]) {
      expect(names).not.toContain(forbidden);
    }

    const res = await mcpClient.callTool({ name: 'plugins.install', arguments: { id: 'org.example.sensors' } });
    expect(res.isError).toBe(true);
  });

  it('handles plugins.index, install (without granting), grant/revoke, list (loaded/failed), panel security, panelEdit, and remove', async () => {
    const root = makeTempDir('cadllm-ws-root-');
    const stateDir = makeTempDir('cadllm-ws-state-');
    const sensorDir = makeTempDir('cadllm-sensor-plugin-');
    const brokenDir = makeTempDir('cadllm-broken-plugin-');
    const outsideFile = join(root, 'secret.txt');
    writeFileSync(outsideFile, 'TOP_SECRET');

    mkdirSync(join(sensorDir, 'panel'), { recursive: true });
    writeFileSync(join(sensorDir, 'panel', 'index.html'), '<html><body><h1>Sensor Panel</h1></body></html>');
    writeFileSync(join(sensorDir, 'panel', 'widget.js'), 'console.log("hi");');
    writeFileSync(join(sensorDir, 'panel', 'huge.html'), 'x'.repeat(600 * 1024));

    const sensorManifest: PluginManifest = {
      id: 'org.example.sensors',
      name: 'Example Sensor Pack',
      version: '1.0.0',
      summary: 'Sensor pack',
      publisher: 'example',
      engine: '^1.0.0',
      license: 'MIT',
      permissions: ['project:read', 'project:write'],
      contributes: {
        parts: 'parts',
        tools: [{ name: 'calc_divider', summary: 'solve resistor divider' }],
        panels: [
          { id: 'sensors', title: 'Sensor Calculator', main: 'panel/index.html' },
          { id: 'jswidget', title: 'JS Widget', main: 'panel/widget.js' },
          { id: 'huge', title: 'Huge', main: 'panel/huge.html' },
          { id: 'escape', title: 'Escape', main: '../secret.txt' },
        ],
      },
    };

    const brokenManifest: PluginManifest = {
      id: 'org.example.broken',
      name: 'Broken Plugin',
      version: '0.1.0',
      publisher: 'example',
      engine: '^1.0.0',
      license: 'MIT',
      permissions: [],
      contributes: {},
    };

    const fakeIndex: RegistryIndex = {
      version: 1,
      keys: { publishers: { example: 'pub' }, signature: 'sig' },
      plugins: [
        {
          id: sensorManifest.id,
          name: sensorManifest.name,
          summary: sensorManifest.summary!,
          publisher: 'example',
          license: 'MIT',
          versions: [
            {
              version: '1.0.0',
              engine: '^1.0.0',
              url: 'packages/sensors.cnlplugin',
              sha256: 'abc',
              size: 100,
              permissions: ['project:read', 'project:write'],
              contributes: ['parts', 'tools', 'panels'],
              signature: 'vsig',
            },
          ],
        },
        {
          id: brokenManifest.id,
          name: brokenManifest.name,
          summary: 'Broken test plugin',
          publisher: 'example',
          license: 'MIT',
          versions: [
            {
              version: '0.1.0',
              engine: '^1.0.0',
              url: 'packages/broken.cnlplugin',
              sha256: 'def',
              size: 50,
              permissions: [],
              contributes: [],
              signature: 'bsig',
            },
          ],
        },
      ],
    };

    let indexSignatureValid = true;
    const installedStore = new Map<string, InstalledPlugin>();
    const grantsStore = new Map<string, PluginPermission[]>();

    const host = new FakePluginHost();
    host.failingIds.add('org.example.broken');
    host.manifestsByDir.set(sensorDir, sensorManifest);
    host.manifestsByDir.set(brokenDir, brokenManifest);

    const fakeRegistry: Partial<PluginRegistryApi> = {
      resolveStateDir: () => stateDir,
      loadIndex: async () => fakeIndex,
      verifyIndex: () => indexSignatureValid,
      resolve: (idx, id) => {
        const plugin = idx.plugins.find(p => p.id === id);
        if (!plugin) throw new Error(`unknown plugin ${id}`);
        return { plugin, version: plugin.versions[0]! } satisfies ResolvedRegistryVersion;
      },
      install: async (entry, installOpts) => {
        const id = 'plugin' in entry ? entry.plugin.id : '';
        const manifest = id === sensorManifest.id ? sensorManifest : brokenManifest;
        const dir = id === sensorManifest.id ? sensorDir : brokenDir;
        const granted = Array.isArray(installOpts?.grant) ? [...installOpts.grant] : [];
        const rec: InstalledPlugin = { id: manifest.id, version: manifest.version, dir, manifest, grants: granted };
        installedStore.set(manifest.id, rec);
        grantsStore.set(manifest.id, granted);
        return rec;
      },
      uninstall: async id => {
        grantsStore.delete(id);
        return installedStore.delete(id);
      },
      listInstalled: () => [...installedStore.values()],
      getGrants: id => [...(grantsStore.get(id) ?? [])],
      setGrants: (id, perms) => {
        const sorted = [...perms].sort() as PluginPermission[];
        grantsStore.set(id, sorted);
        const rec = installedStore.get(id);
        if (rec) rec.grants = sorted;
        return sorted;
      },
    };

    const library = loadLibrary([builtinPartsDir]);
    const workspace = new Workspace({ library, root });
    const httpServer = createHttpServer();
    const wsHandle = attachWebSocket(httpServer, workspace, undefined, {
      stateDir,
      registry: fakeRegistry,
      pluginHost: host,
    });

    await new Promise<void>(resolveListen => httpServer.listen(0, '127.0.0.1', () => resolveListen()));
    const port = (httpServer.address() as AddressInfo).port;
    const client = await WsRpcClient.connect(`ws://127.0.0.1:${port}/ws`);

    cleanups.push(async () => {
      await client.close();
      wsHandle.closeAll();
      await new Promise<void>(r => httpServer.close(() => r()));
    });

    // 1. plugins.index returns verified entries and rejects unverified index
    const indexEntries = await client.call<{ id: string }[]>('plugins.index', {});
    expect(indexEntries.map(e => e.id)).toEqual(['org.example.sensors', 'org.example.broken']);
    indexSignatureValid = false;
    await expect(client.call('plugins.index', {})).rejects.toThrow(/signature verification failed/);
    indexSignatureValid = true;

    // 2. plugins.install installs WITHOUT granting any permissions
    const installedSensor = await client.call<{
      id: string;
      state: string;
      requestedPermissions: string[];
      grantedPermissions: string[];
      contributions: string[];
    }>('plugins.install', { id: 'org.example.sensors', range: '^1.0.0' });
    expect(installedSensor.state).toBe('loaded');
    expect(installedSensor.requestedPermissions).toEqual(['project:read', 'project:write']);
    expect(installedSensor.grantedPermissions).toEqual([]);
    expect(installedSensor.contributions).toEqual(['panels', 'parts', 'tools']);

    const installNote = await client.nextNotification(m => m.method === 'plugins');
    expect(installNote.params).toMatchObject({ action: 'install', id: 'org.example.sensors' });

    // Install failing plugin -> state: 'failed' + error reason
    const installedBroken = await client.call<{ id: string; state: string; error?: string }>('plugins.install', {
      id: 'org.example.broken',
    });
    expect(installedBroken.state).toBe('failed');
    expect(installedBroken.error).toContain('simulated load failure');

    // 3. plugins.list reports both loaded and failed plugins
    const list = await client.call<{ id: string; state: string; error?: string }[]>('plugins.list', {});
    expect(list.map(p => [p.id, p.state])).toEqual([
      ['org.example.broken', 'failed'],
      ['org.example.sensors', 'loaded'],
    ]);

    // 4. plugins.panelEdit denied without project:write
    await expect(client.call('plugins.panelEdit', { id: 'org.example.sensors', cnl: 'R1 res 330' })).rejects.toThrow(
      /permission denied/i,
    );

    // 5. plugins.grant rejects undeclared permissions, grants declared ones
    await expect(
      client.call('plugins.grant', { id: 'org.example.sensors', permissions: ['net:evil.example'] }),
    ).rejects.toThrow(/not requested/i);

    const granted1 = await client.call<{ grantedPermissions: string[] }>('plugins.grant', {
      id: 'org.example.sensors',
      permissions: ['project:read', 'project:write'],
    });
    expect(granted1.grantedPermissions).toEqual(['project:read', 'project:write']);

    // 6. plugins.panelEdit applies CNL edit as source: 'plugin'
    const editRes = await client.call<string>('plugins.panelEdit', {
      id: 'org.example.sensors',
      cnl: 'R1 res 330',
    });
    expect(editRes).toMatch(/^ok rev=1 /);
    const changedNote = await client.nextNotification(m => m.method === 'changed');
    expect(changedNote.params).toMatchObject({ rev: 1, source: 'plugin' });
    const histLog = await client.call<string>('history', { op: 'log' });
    expect(histLog).toContain('rev 1 plugin');

    // 7. plugins.revoke removes specified permissions
    const revoked = await client.call<{ grantedPermissions: string[] }>('plugins.revoke', {
      id: 'org.example.sensors',
      permissions: ['project:write'],
    });
    expect(revoked.grantedPermissions).toEqual(['project:read']);
    await expect(client.call('plugins.panelEdit', { id: 'org.example.sensors', cnl: 'R2 res 1k' })).rejects.toThrow(
      /permission denied/i,
    );

    // 8. plugins.panel reads HTML & wraps JS, enforces containment & size cap
    const htmlPanel = await client.call<{ html: string; title: string }>('plugins.panel', {
      id: 'org.example.sensors',
      panel: 'sensors',
    });
    expect(htmlPanel.title).toBe('Sensor Calculator');
    expect(htmlPanel.html).toContain('Sensor Panel');

    const jsPanel = await client.call<{ html: string }>('plugins.panel', {
      id: 'org.example.sensors',
      panel: 'jswidget',
    });
    expect(jsPanel.html).toContain('<script>console.log("hi");</script>');

    await expect(
      client.call('plugins.panel', { id: 'org.example.sensors', panel: 'escape' }),
    ).rejects.toThrow(/unsafe panel path/i);
    await expect(
      client.call('plugins.panel', { id: 'org.example.sensors', panel: 'huge' }),
    ).rejects.toThrow(/exceeds/i);

    // Test symlink escape if OS permits creating symlinks
    const symlinkPath = join(sensorDir, 'panel', 'link.html');
    let symlinkCreated = false;
    try {
      symlinkSync(outsideFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      sensorManifest.contributes.panels!.push({ id: 'link', title: 'Link', main: 'panel/link.html' });
      await expect(
        client.call('plugins.panel', { id: 'org.example.sensors', panel: 'link' }),
      ).rejects.toThrow(/escapes plugin directory/i);
    }

    // 9. plugins.remove unloads and uninstalls
    const removed = await client.call<{ id: string; removed: boolean }>('plugins.remove', {
      id: 'org.example.sensors',
    });
    expect(removed).toEqual({ id: 'org.example.sensors', removed: true });
    expect(host.list().some(p => p.manifest.id === 'org.example.sensors')).toBe(false);
  });
});
