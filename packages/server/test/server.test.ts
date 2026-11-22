// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { findServe, startServer, type RunningServer } from '../src/index.ts';

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

  static connect(url: string, headers?: Record<string, string>): Promise<WsRpcClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      ws.once('open', () => resolve(new WsRpcClient(ws)));
      ws.once('error', err => reject(err));
    });
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: msg => {
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        },
        reject,
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  callRaw(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

describe('cadllm serve', () => {
  const dirs: string[] = [];
  const servers: RunningServer[] = [];

  function makeTempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('co-edits live between MCP HTTP (AI) and WebSocket (user), checks Origin, and tracks serve.json', async () => {
    const root = makeTempDir('cadllm-root-');
    const serveFileDir = makeTempDir('cadllm-state-');
    const missingUiDir = join(root, 'no-such-ui-dist');

    const srv = await startServer({ port: 0, root, serveFileDir, uiDistDir: missingUiDir });
    servers.push(srv);
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // findServe discovers the running server
    expect(await findServe({ serveFileDir })).toBe(srv.url);

    // Static fallback when ui/dist is missing
    const homeRes = await fetch(srv.url);
    expect(homeRes.status).toBe(200);
    expect(await homeRes.text()).toContain('npm run build -w @cadllm/ui');

    // Origin guard on /mcp
    const badMcpOrigin = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(badMcpOrigin.status).toBe(403);

    // Origin guard on /ws
    const wsUrl = srv.url.replace(/^http:/, 'ws:') + '/ws';
    await expect(WsRpcClient.connect(wsUrl, { Origin: 'https://evil.example' })).rejects.toThrow(/403/);
    await expect(WsRpcClient.connect(wsUrl, { Origin: 'null' })).rejects.toThrow(/403/);

    // Connect AI (MCP Streamable HTTP) and user (WebSocket)
    const mcpClient = new Client({ name: 'test-ai', version: '0.0.0' });
    const mcpTransport = new StreamableHTTPClientTransport(new URL('/mcp', srv.url));
    await mcpClient.connect(mcpTransport);
    const wsClient = await WsRpcClient.connect(wsUrl);

    try {
      const toolText = async (name: string, args: Record<string, unknown>) =>
        ((await mcpClient.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;

      // 1. AI edit -> ws receives changed notification with source: 'ai'
      const aiEdit = await toolText('edit', {
        cnl: 'BAT1 battery 5V; R1 res 330; D1 led red; VCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-',
      });
      expect(aiEdit).toMatch(/^ok rev=1 /);

      const aiNote = await wsClient.nextNotification(m => m.method === 'changed');
      expect(aiNote.params).toMatchObject({
        project: 'untitled',
        rev: 1,
        source: 'ai',
      });
      expect(typeof aiNote.params?.summary).toBe('string');
      expect(aiNote.params?.delta).toBeTruthy();

      // 2. User edit over ws -> shows up in AI's read since=1
      const userEdit = await wsClient.call('edit', { cnl: '~R1 value=470' });
      expect(String(userEdit)).toMatch(/^ok rev=2 /);

      const userNote = await wsClient.nextNotification(m => m.method === 'changed');
      expect(userNote.params).toMatchObject({
        project: 'untitled',
        rev: 2,
        source: 'user',
      });

      const sinceText = await toolText('read', { since: 1 });
      expect(sinceText).toContain('since 1');
      expect(sinceText).toContain('R1');
      expect(sinceText).toContain('470');

      // 3. state returns circuit + only used parts
      const state = (await wsClient.call('state', {})) as {
        project: string;
        rev: number;
        projects: { name: string; rev: number; source?: string }[];
        circuit: { components: Record<string, unknown> };
        parts: Record<string, unknown>;
      };
      expect(state.project).toBe('untitled');
      expect(state.rev).toBe(2);
      expect(state.projects).toEqual([{ name: 'untitled', rev: 2, source: 'user' }]);
      expect(Object.keys(state.circuit.components)).toHaveLength(3);
      expect(Object.keys(state.parts).sort()).toEqual(['battery', 'led', 'res']);

      // 4. library returns PartDef[]
      const lib = (await wsClient.call('library', {})) as { id: string }[];
      expect(Array.isArray(lib)).toBe(true);
      expect(lib.some(p => p.id === 'res')).toBe(true);

      // 5. render turns thrown error (e.g. unknown view) into JSON-RPC -32000 error
      const badRender = await wsClient.callRaw('render', { view: 'nope' });
      expect(badRender.error?.code).toBe(-32000);
      expect(badRender.error?.message).toContain('unknown view');

      // 6. AI auto-layout reaches the user live; both sides can draw it
      expect(await toolText('layout', { view: 'bb' })).toMatch(/^ok rev=3 placed 3 in bb: /);
      const layoutNote = await wsClient.nextNotification(m => m.method === 'changed');
      expect(layoutNote.params).toMatchObject({ rev: 3, source: 'ai', label: 'layout bb' });
      expect(String(await wsClient.call('render', { view: 'bb', highlight: ['R1'] }))).toContain('data-ref="R1"');
      const png = (await mcpClient.callTool({ name: 'render', arguments: { view: 'bb', width: 300 } })).content as { type: string; text?: string; data?: string; mimeType?: string }[];
      expect(png[0]).toEqual({ type: 'text', text: 'untitled rev=3 bb: 3 parts drawn' });
      expect(png[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(Buffer.from(png[1]!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

      // 7. A first POST that isn't initialize is refused and leaves no half-open session behind
      const stray = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(stray.status).toBeGreaterThanOrEqual(400);
      expect(stray.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await wsClient.close();
      await mcpTransport.terminateSession().catch(() => {});
      await mcpClient.close();
    }

    // findServe returns undefined after close
    await srv.close();
    expect(await findServe({ serveFileDir })).toBeUndefined();
  });

  it('serves static ui/dist files and blocks path traversal', async () => {
    const root = makeTempDir('cadllm-root-');
    const serveFileDir = makeTempDir('cadllm-state-');
    const uiDistDir = makeTempDir('cadllm-ui-');
    mkdirSync(join(uiDistDir, 'assets'), { recursive: true });
    writeFileSync(join(uiDistDir, 'index.html'), '<html><body>CadLLM UI</body></html>');
    writeFileSync(join(uiDistDir, 'assets', 'app.js'), 'console.log("ok");');

    const srv = await startServer({ port: 0, root, serveFileDir, uiDistDir });
    servers.push(srv);

    const indexRes = await fetch(`${srv.url}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get('content-type')).toContain('text/html');
    expect(await indexRes.text()).toContain('CadLLM UI');

    const jsRes = await fetch(`${srv.url}/assets/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-type')).toContain('text/javascript');

    const traversal = await fetch(`${srv.url}/..%2Fpackage.json`);
    expect(traversal.status).toBe(403);
  });
});
