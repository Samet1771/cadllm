// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CadError, errorText, type ChangeSource, type Circuit, type PartDef } from '@cadllm/core';
import { printDelta } from '@cadllm/dsl';
import { Engine, type Workspace } from '@cadllm/engine';
import { TOOLS } from '@cadllm/mcp';
import {
  contributedKinds,
  isValidPermission,
  type ContributionKind,
  type PluginContributes,
  type PluginPermission,
} from '@cadllm/plugin-api';
import { PluginHost, type LoadedPlugin } from '@cadllm/plugins';
import {
  getGrants as defaultGetGrants,
  install as defaultInstall,
  listInstalled as defaultListInstalled,
  loadIndex as defaultLoadIndex,
  resolve as defaultResolve,
  resolveStateDir as defaultResolveStateDir,
  setGrants as defaultSetGrants,
  uninstall as defaultUninstall,
  verifyIndex as defaultVerifyIndex,
  type InstalledPlugin,
  type RegistryIndex,
  type RegistryPluginEntry,
} from '@cadllm/registry';
import { view } from '@cadllm/views';
import { WebSocketServer, type WebSocket } from 'ws';
import { isLocalRequest } from './security.ts';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface SafeSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues?: { message: string }[]; message?: string } };
}

type ToolName = keyof typeof TOOLS;

const TOOL_NAMES = new Set<string>(Object.keys(TOOLS));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate `params` against the Zod field schemas from `@cadllm/mcp`'s `TOOLS` table. */
function parseToolParams(name: ToolName, params: unknown): Record<string, unknown> {
  if (params !== undefined && !isPlainObject(params)) {
    throw new CadError('invalid', `${name} params must be an object`);
  }
  const raw = params ?? {};
  const schema = TOOLS[name].inputSchema as Record<string, SafeSchema>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const res = field.safeParse(raw[key]);
    if (!res.success) {
      const msg = res.error?.issues?.[0]?.message ?? res.error?.message ?? 'invalid value';
      throw new CadError('invalid', `${name}.${key}: ${msg}`);
    }
    if (res.data !== undefined) out[key] = res.data;
  }
  return out;
}

async function callTool(engine: Engine, name: ToolName, params: unknown): Promise<string> {
  const args = parseToolParams(name, params);
  switch (name) {
    case 'project': return engine.project(args as Parameters<Engine['project']>[0]);
    case 'read': return engine.read(args as Parameters<Engine['read']>[0]);
    case 'edit': return engine.edit(args as Parameters<Engine['edit']>[0]);
    case 'find': return engine.find(args as Parameters<Engine['find']>[0]);
    case 'check': return engine.check();
    case 'sim': return engine.sim(args as Parameters<Engine['sim']>[0]);
    case 'history': return engine.history(args as Parameters<Engine['history']>[0]);
    case 'layout': return engine.layout(args as Parameters<Engine['layout']>[0]);
    case 'render': return callRender(engine, params); // the /ws render returns SVG; dispatched before this
    case 'export': return engine.export(args as Parameters<Engine['export']>[0]);
    case 'help': return engine.help(args as Parameters<Engine['help']>[0]);
    case 'ext': return engine.ext(args as Parameters<Engine['ext']>[0]);
  }
}

function buildState(engine: Engine, workspace: Workspace): {
  project: string;
  rev: number;
  projects: { name: string; rev: number; source?: ChangeSource }[];
  circuit: Circuit;
  parts: Record<string, PartDef>;
} {
  const doc = engine.doc;
  const circuit = doc.read.circuit;
  const parts: Record<string, PartDef> = {};
  for (const comp of Object.values(circuit.components)) {
    if (!parts[comp.part]) {
      const def = workspace.library.get(comp.part);
      if (def) parts[comp.part] = def;
    }
  }
  const projects = workspace.all().map(p => {
    const last = p.log[p.log.length - 1];
    return { name: p.name, rev: p.doc.rev, ...(last ? { source: last.source } : {}) };
  });
  return { project: engine.projectName, rev: doc.rev, projects, circuit, parts };
}

function callRender(engine: Engine, params: unknown): string {
  if (!isPlainObject(params) || typeof params.view !== 'string') {
    throw new CadError('invalid', 'render requires view');
  }
  const highlight = Array.isArray(params.highlight) ? params.highlight.filter((x): x is string => typeof x === 'string') : undefined;
  const select = Array.isArray(params.select) ? params.select.filter((x): x is string => typeof x === 'string') : undefined;
  const theme = params.theme === 'light' || params.theme === 'dark' ? params.theme : undefined;
  const labels = typeof params.labels === 'boolean' ? params.labels : undefined;
  return view(params.view).render(engine.doc.read, {
    ...(highlight ? { highlight } : {}),
    ...(select ? { select } : {}),
    ...(theme ? { theme } : {}),
    ...(labels !== undefined ? { labels } : {}),
  });
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

const MAX_PANEL_BYTES = 512 * 1024;
const MAX_PANEL_EDIT_BYTES = 32 * 1024;

export interface PluginRegistryApi {
  resolveStateDir(override?: string): string;
  loadIndex(url?: string): Promise<RegistryIndex>;
  verifyIndex(index: RegistryIndex, registryPublicKey?: string): boolean;
  resolve(index: RegistryIndex, id: string, range?: string, engineVersion?: string): ReturnType<typeof defaultResolve>;
  install(
    entry: Parameters<typeof defaultInstall>[0],
    opts?: Parameters<typeof defaultInstall>[1],
  ): Promise<InstalledPlugin>;
  uninstall(id: string, opts?: { version?: string; stateDir?: string }): Promise<boolean>;
  listInstalled(opts?: { stateDir?: string }): InstalledPlugin[];
  getGrants(id: string, opts?: { stateDir?: string }): PluginPermission[];
  setGrants(id: string, permissions: PluginPermission[], opts?: { stateDir?: string }): PluginPermission[];
}

export interface AttachWebSocketOptions {
  stateDir?: string;
  indexUrl?: string;
  registryPublicKey?: string;
  registry?: Partial<PluginRegistryApi>;
  pluginHost?: PluginHost;
}

export interface WsPluginStatus {
  id: string;
  name: string;
  version: string;
  summary?: string;
  publisher?: string;
  license: string;
  state: 'loaded' | 'failed';
  error?: string;
  requestedPermissions: PluginPermission[];
  grantedPermissions: PluginPermission[];
  contributions: ContributionKind[];
  contributes: PluginContributes;
}

function isSafeRelativePanelPath(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return false;
  }
  return !trimmed.split(/[/\\]+/).some(seg => seg === '..');
}

function isPathInsideDir(rootDir: string, targetPath: string): boolean {
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  const rel = relative(rootDir, targetPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return targetPath === rootDir || targetPath.startsWith(rootWithSep);
}

function parsePermissionArray(raw: unknown, fieldName: string): PluginPermission[] {
  if (!Array.isArray(raw)) {
    throw new CadError('invalid', `${fieldName} must be an array of permission strings`);
  }
  const out: PluginPermission[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !isValidPermission(item)) {
      throw new CadError('invalid', `invalid permission "${String(item)}"`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function buildPluginStatus(
  entry: { manifest: InstalledPlugin['manifest']; grants: PluginPermission[] },
  loaded: LoadedPlugin | undefined,
  loadError: string | undefined,
): WsPluginStatus {
  const m = entry.manifest;
  const granted = loaded ? [...loaded.grants] : [...entry.grants];
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.summary ? { summary: m.summary } : {}),
    ...(m.publisher ? { publisher: m.publisher } : {}),
    license: m.license,
    state: loaded ? 'loaded' : 'failed',
    ...(loaded ? {} : { error: loadError ?? 'plugin is not loaded' }),
    requestedPermissions: [...m.permissions],
    grantedPermissions: granted,
    contributions: contributedKinds(m),
    contributes: m.contributes,
  };
}

function wrapPanelEntryHtml(mainPath: string, raw: string): string {
  const lower = mainPath.trim().toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
    const safeJs = raw.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script>${safeJs}</script></body></html>`;
  }
  return raw;
}

/** Attach the `/ws` JSON-RPC 2.0 WebSocket server to `httpServer` over one shared `Workspace`. */
export function attachWebSocket(
  httpServer: HttpServer,
  workspace: Workspace,
  defaultProject?: string,
  opts: AttachWebSocketOptions = {},
): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const registry: PluginRegistryApi = {
    resolveStateDir: opts.registry?.resolveStateDir ?? defaultResolveStateDir,
    loadIndex: opts.registry?.loadIndex ?? defaultLoadIndex,
    verifyIndex: opts.registry?.verifyIndex ?? defaultVerifyIndex,
    resolve: opts.registry?.resolve ?? defaultResolve,
    install: opts.registry?.install ?? defaultInstall,
    uninstall: opts.registry?.uninstall ?? defaultUninstall,
    listInstalled: opts.registry?.listInstalled ?? defaultListInstalled,
    getGrants: opts.registry?.getGrants ?? defaultGetGrants,
    setGrants: opts.registry?.setGrants ?? defaultSetGrants,
  };

  const stateDir = registry.resolveStateDir(opts.stateDir);
  const host = opts.pluginHost ?? workspace.plugins ?? (() => {
    const created = new PluginHost();
    workspace.setPlugins(created);
    return created;
  })();
  if (!workspace.plugins) workspace.setPlugins(host);

  const loadErrors = new Map<string, string>();

  const tryLoadPlugin = (dir: string, id: string, grants: PluginPermission[]): void => {
    host.unload(id);
    try {
      host.load(dir, { grants });
      loadErrors.delete(id);
    } catch (err) {
      loadErrors.set(id, errorText(err));
    }
  };

  const syncInstalledPlugins = (): void => {
    let installed: InstalledPlugin[];
    try {
      installed = registry.listInstalled({ stateDir });
    } catch {
      return;
    }
    const loadedIds = new Set(host.list().map(p => p.manifest.id));
    for (const item of installed) {
      if (!loadedIds.has(item.id) && !loadErrors.has(item.id)) {
        const grants = registry.getGrants(item.id, { stateDir });
        tryLoadPlugin(item.dir, item.id, grants);
      }
    }
  };

  syncInstalledPlugins();

  const broadcastPluginsChanged = (action: string, id?: string): void => {
    for (const client of sockets) {
      sendJson(client, {
        jsonrpc: '2.0',
        method: 'plugins',
        params: { action, ...(id !== undefined ? { id } : {}) },
      });
    }
  };

  const listPluginStatuses = (): WsPluginStatus[] => {
    syncInstalledPlugins();
    const installed = registry.listInstalled({ stateDir });
    const loadedById = new Map(host.list().map(p => [p.manifest.id, p]));
    const seen = new Set<string>();
    const out: WsPluginStatus[] = [];

    for (const item of installed) {
      seen.add(item.id);
      const loaded = loadedById.get(item.id);
      const grants = registry.getGrants(item.id, { stateDir });
      out.push(buildPluginStatus({ manifest: item.manifest, grants }, loaded, loadErrors.get(item.id)));
    }
    for (const loaded of loadedById.values()) {
      if (seen.has(loaded.manifest.id)) continue;
      out.push(buildPluginStatus({ manifest: loaded.manifest, grants: loaded.grants }, loaded, undefined));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };

  const readVerifiedIndex = async (): Promise<RegistryIndex> => {
    const index = await registry.loadIndex(opts.indexUrl);
    if (!registry.verifyIndex(index, opts.registryPublicKey)) {
      throw new CadError('invalid', 'registry index signature verification failed');
    }
    return index;
  };

  const handlePluginRpc = async (engine: Engine, method: string, params: unknown): Promise<unknown> => {
    const p = isPlainObject(params) ? params : {};
    switch (method) {
      case 'plugins.list':
        return listPluginStatuses();

      case 'plugins.index': {
        const index = await readVerifiedIndex();
        return index.plugins satisfies RegistryPluginEntry[];
      }

      case 'plugins.install': {
        if (typeof p.id !== 'string' || !p.id.trim()) {
          throw new CadError('invalid', 'plugins.install requires id');
        }
        const id = p.id.trim();
        const range = typeof p.range === 'string' && p.range.trim() ? p.range.trim() : undefined;
        const index = await readVerifiedIndex();
        const resolved = registry.resolve(index, id, range);
        const installed = await registry.install(resolved, {
          stateDir,
          index,
          grant: [],
        });
        tryLoadPlugin(installed.dir, installed.id, []);
        broadcastPluginsChanged('install', installed.id);
        return listPluginStatuses().find(item => item.id === installed.id)
          ?? buildPluginStatus(
            { manifest: installed.manifest, grants: [] },
            host.list().find(x => x.manifest.id === installed.id),
            loadErrors.get(installed.id),
          );
      }

      case 'plugins.grant': {
        if (typeof p.id !== 'string' || !p.id.trim()) {
          throw new CadError('invalid', 'plugins.grant requires id');
        }
        const id = p.id.trim();
        const toGrant = parsePermissionArray(p.permissions, 'permissions');
        const installed = registry.listInstalled({ stateDir }).find(item => item.id === id);
        if (!installed) {
          throw new CadError('invalid', `plugin ${id} is not installed`);
        }
        const declared = new Set<string>(installed.manifest.permissions);
        for (const perm of toGrant) {
          if (!declared.has(perm)) {
            throw new CadError('invalid', `permission "${perm}" is not requested by plugin ${id}`);
          }
        }
        const merged = new Set<PluginPermission>(registry.getGrants(id, { stateDir }));
        for (const perm of toGrant) merged.add(perm);
        const nextGrants = [...merged].sort() as PluginPermission[];
        const saved = registry.setGrants(id, nextGrants, { stateDir });
        tryLoadPlugin(installed.dir, id, saved);
        broadcastPluginsChanged('grant', id);
        return listPluginStatuses().find(item => item.id === id)
          ?? buildPluginStatus(
            { manifest: installed.manifest, grants: saved },
            host.list().find(x => x.manifest.id === id),
            loadErrors.get(id),
          );
      }

      case 'plugins.revoke': {
        if (typeof p.id !== 'string' || !p.id.trim()) {
          throw new CadError('invalid', 'plugins.revoke requires id');
        }
        const id = p.id.trim();
        const installed = registry.listInstalled({ stateDir }).find(item => item.id === id);
        if (!installed) {
          throw new CadError('invalid', `plugin ${id} is not installed`);
        }
        let nextGrants: PluginPermission[];
        if (p.permissions !== undefined) {
          const toRevoke = new Set(parsePermissionArray(p.permissions, 'permissions'));
          nextGrants = registry.getGrants(id, { stateDir }).filter(perm => !toRevoke.has(perm)).sort() as PluginPermission[];
        } else {
          nextGrants = [];
        }
        const saved = registry.setGrants(id, nextGrants, { stateDir });
        tryLoadPlugin(installed.dir, id, saved);
        broadcastPluginsChanged('revoke', id);
        return listPluginStatuses().find(item => item.id === id)
          ?? buildPluginStatus(
            { manifest: installed.manifest, grants: saved },
            host.list().find(x => x.manifest.id === id),
            loadErrors.get(id),
          );
      }

      case 'plugins.remove': {
        if (typeof p.id !== 'string' || !p.id.trim()) {
          throw new CadError('invalid', 'plugins.remove requires id');
        }
        const id = p.id.trim();
        host.unload(id);
        loadErrors.delete(id);
        const removed = await registry.uninstall(id, { stateDir });
        broadcastPluginsChanged('remove', id);
        return { id, removed };
      }

      case 'plugins.panel': {
        if (typeof p.id !== 'string' || !p.id.trim() || typeof p.panel !== 'string' || !p.panel.trim()) {
          throw new CadError('invalid', 'plugins.panel requires id and panel');
        }
        const id = p.id.trim();
        const panelId = p.panel.trim();
        const installed = registry.listInstalled({ stateDir }).find(item => item.id === id);
        const loaded = host.list().find(item => item.manifest.id === id);
        const manifest = installed?.manifest ?? loaded?.manifest;
        const pluginDir = installed?.dir ?? loaded?.dir;
        if (!manifest || !pluginDir) {
          throw new CadError('invalid', `plugin ${id} is not installed`);
        }
        const panelDef = manifest.contributes.panels?.find(item => item.id === panelId);
        if (!panelDef) {
          throw new CadError('invalid', `unknown panel "${panelId}" for plugin ${id}`);
        }
        if (!isSafeRelativePanelPath(panelDef.main)) {
          throw new CadError('invalid', `unsafe panel path "${panelDef.main}"`);
        }
        const rootResolved = resolve(pluginDir);
        const targetResolved = resolve(rootResolved, panelDef.main);
        if (!isPathInsideDir(rootResolved, targetResolved)) {
          throw new CadError('invalid', `panel path "${panelDef.main}" escapes plugin directory`);
        }
        let rootReal: string;
        let targetReal: string;
        try {
          rootReal = realpathSync(rootResolved);
          const linkStat = lstatSync(targetResolved);
          if (linkStat.isSymbolicLink()) {
            targetReal = realpathSync(targetResolved);
            if (!isPathInsideDir(rootReal, targetReal)) {
              throw new CadError('invalid', `panel symlink "${panelDef.main}" escapes plugin directory`);
            }
          } else {
            targetReal = realpathSync(targetResolved);
          }
        } catch (err) {
          if (err instanceof CadError) throw err;
          throw new CadError('invalid', `panel file "${panelDef.main}" not found`);
        }
        if (!isPathInsideDir(rootReal, targetReal)) {
          throw new CadError('invalid', `panel path "${panelDef.main}" escapes plugin directory`);
        }
        const st = statSync(targetReal);
        if (!st.isFile()) {
          throw new CadError('invalid', `panel entry "${panelDef.main}" is not a file`);
        }
        if (st.size > MAX_PANEL_BYTES) {
          throw new CadError('invalid', `panel entry exceeds ${MAX_PANEL_BYTES} bytes`);
        }
        const raw = readFileSync(targetReal, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_PANEL_BYTES) {
          throw new CadError('invalid', `panel entry exceeds ${MAX_PANEL_BYTES} bytes`);
        }
        return {
          id,
          panel: panelDef.id,
          title: panelDef.title,
          html: wrapPanelEntryHtml(panelDef.main, raw),
        };
      }

      case 'plugins.panelEdit': {
        if (typeof p.id !== 'string' || !p.id.trim() || typeof p.cnl !== 'string' || !p.cnl.trim()) {
          throw new CadError('invalid', 'plugins.panelEdit requires id and cnl');
        }
        if (Buffer.byteLength(p.cnl, 'utf8') > MAX_PANEL_EDIT_BYTES) {
          throw new CadError('invalid', 'panel edit exceeds maximum size');
        }
        const id = p.id.trim();
        const installed = registry.listInstalled({ stateDir }).find(item => item.id === id);
        const loaded = host.list().find(item => item.manifest.id === id);
        if (!installed && !loaded) {
          throw new CadError('invalid', `plugin ${id} is not installed`);
        }
        const grants = installed
          ? registry.getGrants(id, { stateDir })
          : (loaded?.grants ?? []);
        if (!grants.includes('project:write')) {
          throw new CadError('invalid', `permission denied: plugin "${id}" does not have project:write`);
        }
        return engine.edit({ cnl: p.cnl }, 'plugin');
      }

      default:
        return undefined;
    }
  };

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isLocalRequest(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    sockets.add(ws);
    const engine = new Engine({ workspace, source: 'user' });
    if (defaultProject && workspace.has(defaultProject)) {
      engine.project({ op: 'use', name: defaultProject });
    }

    const unsubscribe = workspace.on(event => {
      if (event.type === 'change') {
        const p = workspace.get(event.project);
        const summary = p.log[p.log.length - 1]?.summary
          ?? printDelta(event.info, p.doc.read).replace(/^ok rev=\d+ ?/, '');
        sendJson(ws, {
          jsonrpc: '2.0',
          method: 'changed',
          params: {
            project: event.project,
            rev: event.info.rev,
            source: event.info.source,
            ...(event.info.label !== undefined ? { label: event.info.label } : {}),
            delta: event.info.delta,
            summary,
          },
        });
      } else {
        sendJson(ws, {
          jsonrpc: '2.0',
          method: 'projects',
          params: { names: workspace.names() },
        });
      }
    });

    ws.on('message', async raw => {
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(raw.toString()) as JsonRpcRequest;
      } catch {
        sendJson(ws, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }

      if (!isPlainObject(msg) || typeof msg.method !== 'string') {
        sendJson(ws, { jsonrpc: '2.0', id: (msg as JsonRpcRequest)?.id ?? null, error: { code: -32600, message: 'invalid request' } });
        return;
      }

      const id = msg.id;
      const replyResult = (result: unknown): void => {
        if (id !== undefined) sendJson(ws, { jsonrpc: '2.0', id, result });
      };
      const replyError = (code: number, message: string): void => {
        if (id !== undefined) sendJson(ws, { jsonrpc: '2.0', id, error: { code, message } });
      };

      try {
        const method = msg.method;
        if (method === 'render') {
          replyResult(callRender(engine, msg.params));
        } else if (TOOL_NAMES.has(method)) {
          replyResult(await callTool(engine, method as ToolName, msg.params));
        } else if (method === 'state') {
          replyResult(buildState(engine, workspace));
        } else if (method === 'library') {
          replyResult(workspace.library.all());
        } else if (
          method === 'plugins.list' ||
          method === 'plugins.index' ||
          method === 'plugins.install' ||
          method === 'plugins.grant' ||
          method === 'plugins.revoke' ||
          method === 'plugins.remove' ||
          method === 'plugins.panel' ||
          method === 'plugins.panelEdit'
        ) {
          replyResult(await handlePluginRpc(engine, method, msg.params));
        } else {
          replyError(-32601, `unknown method ${method}`);
        }
      } catch (err) {
        replyError(-32000, errorText(err));
      }
    });

    ws.on('close', () => {
      unsubscribe();
      sockets.delete(ws);
    });
  });

  return {
    closeAll() {
      for (const ws of sockets) ws.close();
      sockets.clear();
      wss.close();
    },
  };
}
