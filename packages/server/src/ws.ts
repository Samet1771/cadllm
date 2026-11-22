// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Server as HttpServer } from 'node:http';
import { CadError, errorText, type ChangeSource, type Circuit, type PartDef } from '@cadllm/core';
import { printDelta } from '@cadllm/dsl';
import { Engine, type Workspace } from '@cadllm/engine';
import { TOOLS } from '@cadllm/mcp';
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
    case 'part': return engine.part(args as Parameters<Engine['part']>[0]);
    case 'check': return engine.check();
    case 'sim': return engine.sim(args as Parameters<Engine['sim']>[0]);
    case 'history': return engine.history(args as Parameters<Engine['history']>[0]);
    case 'layout': return engine.layout(args as Parameters<Engine['layout']>[0]);
    case 'render': return callRender(engine, params); // the /ws render returns SVG; dispatched before this
    case 'export': return engine.export(args as Parameters<Engine['export']>[0]);
    case 'help': return engine.help(args as Parameters<Engine['help']>[0]);
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

/** Attach the `/ws` JSON-RPC 2.0 WebSocket server to `httpServer` over one shared `Workspace`. */
export function attachWebSocket(
  httpServer: HttpServer,
  workspace: Workspace,
  defaultProject?: string,
): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

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
