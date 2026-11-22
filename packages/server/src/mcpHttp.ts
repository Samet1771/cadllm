// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Engine, type Workspace } from '@cadllm/engine';
import { createServer } from '@cadllm/mcp';
import { isLocalRequest } from './security.ts';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  engine: Engine;
}

export interface McpHttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  closeAll(): Promise<void>;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Stateful Streamable HTTP MCP handler for `/mcp` backed by one shared `Workspace`. */
export function createMcpHandler(workspace: Workspace, defaultProject?: string): McpHttpHandler {
  const sessions = new Map<string, McpSession>();

  const dropSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.server.close().catch(() => {});
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalRequest(req)) {
      jsonRpcError(res, 403, -32000, 'Forbidden: non-local Host or Origin');
      return;
    }

    const rawId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawId) ? rawId[0] : rawId;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        jsonRpcError(res, 404, -32000, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      jsonRpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id');
      return;
    }

    const engine = new Engine({ workspace, source: 'ai' });
    if (defaultProject && workspace.has(defaultProject)) {
      engine.project({ op: 'use', name: defaultProject });
    }
    const server = createServer(engine);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        sessions.set(id, { server, transport, engine });
      },
      onsessionclosed: id => {
        dropSession(id);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) dropSession(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (!transport.sessionId) await server.close();
  }

  async function closeAll(): Promise<void> {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(active.map(async s => {
      await s.transport.close();
      await s.server.close();
    }));
  }

  return { handle, closeAll };
}
