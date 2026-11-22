// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FindServeOptions {
  /** Override `~/.cadllm` directory (also respects `CADLLM_STATE_DIR` env var). */
  serveFileDir?: string;
}

interface ServeFile {
  port: number;
  pid: number;
}

export function resolveServeDir(override?: string): string {
  return override ?? process.env.CADLLM_STATE_DIR ?? join(homedir(), '.cadllm');
}

export function writeServeFile(dir: string, port: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'serve.json'), `${JSON.stringify({ port, pid: process.pid })}\n`);
}

export function removeServeFile(dir: string): void {
  const file = join(dir, 'serve.json');
  try {
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServeFile>;
    if (raw.pid === undefined || raw.pid === process.pid) {
      rmSync(file, { force: true });
    }
  } catch {
    rmSync(file, { force: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Return the URL of a running `cadllm serve` instance if its PID is alive and its port answers. */
export async function findServe(opts: FindServeOptions = {}): Promise<string | undefined> {
  const file = join(resolveServeDir(opts.serveFileDir), 'serve.json');
  if (!existsSync(file)) return undefined;

  let data: Partial<ServeFile>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServeFile>;
  } catch {
    return undefined;
  }

  if (typeof data.port !== 'number' || data.port <= 0 || typeof data.pid !== 'number' || data.pid <= 0) {
    return undefined;
  }
  if (!isPidAlive(data.pid)) return undefined;

  const url = `http://127.0.0.1:${data.port}`;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Bridge stdio MCP to a running `cadllm serve` HTTP MCP endpoint. */
export async function proxyStdio(url: string): Promise<void> {
  const mcpUrl = new URL('/mcp', url.endsWith('/') ? url : `${url}/`);
  const client = new Client({ name: 'cadllm-stdio-proxy', version: '0.0.0' });
  const clientTransport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(clientTransport);

  const server = new Server(
    { name: 'cadllm', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async req => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async req => client.callTool(req.params));

  server.onclose = () => {
    client.close().catch(() => {});
  };

  await server.connect(new StdioServerTransport());
}
