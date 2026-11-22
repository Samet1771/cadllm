// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, Workspace } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { findServe, proxyStdio, removeServeFile, resolveServeDir, writeServeFile, type FindServeOptions } from './attach.ts';
import { createMcpHandler } from './mcpHttp.ts';
import { serveStatic } from './static.ts';
import { attachWebSocket } from './ws.ts';

export { findServe, proxyStdio, type FindServeOptions };

export interface ServeOptions {
  port?: number;
  host?: string;
  root?: string;
  /** Optional `.cnl` file to open on startup. */
  open?: string;
  /** Override `~/.cadllm` directory for `serve.json` (also respects `CADLLM_STATE_DIR`). */
  serveFileDir?: string;
  /** Override `packages/ui/dist` directory. */
  uiDistDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 5170;
const DEFAULT_UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/dist');

/** Start the CadLLM HTTP, WebSocket (`/ws`), and Streamable HTTP MCP (`/mcp`) server. */
export async function startServer(opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const uiDistDir = opts.uiDistDir ?? DEFAULT_UI_DIST;
  const serveDir = resolveServeDir(opts.serveFileDir);

  const library = loadLibrary([builtinPartsDir]);
  const workspace = new Workspace({ library, ...(opts.root ? { root: opts.root } : {}) });

  let defaultProject: string | undefined;
  if (opts.open) {
    const loader = new Engine({ workspace, source: 'user' });
    loader.project({ op: 'open', path: opts.open });
    defaultProject = loader.projectName;
  }

  const mcp = createMcpHandler(workspace, defaultProject);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    if (pathname === '/mcp') {
      await mcp.handle(req, res);
      return;
    }
    serveStatic(req, res, uiDistDir);
  };

  const httpServer = createHttpServer((req, res) => {
    handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    });
  });

  const ws = attachWebSocket(httpServer, workspace, defaultProject);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => rejectListen(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      resolveListen();
    });
  });

  const actualPort = (httpServer.address() as AddressInfo).port;
  const url = `http://${host}:${actualPort}`;
  writeServeFile(serveDir, actualPort);

  let closed = false;
  const onExit = () => removeServeFile(serveDir);
  process.once('exit', onExit);

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    process.off('exit', onExit);
    removeServeFile(serveDir);
    ws.closeAll();
    await mcp.closeAll();
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close(err => (err ? rejectClose(err) : resolveClose()));
      httpServer.closeAllConnections();
    });
  }

  return { url, port: actualPort, close };
}

/** CLI entry point for `cadllm serve [file.cnl] [--port 5170]`. */
export async function main(argv: string[]): Promise<number> {
  let open: string | undefined;
  let port = DEFAULT_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' || arg === '-p') {
      const val = argv[++i];
      if (!val || !/^\d+$/.test(val)) {
        console.error('error: --port requires an integer');
        return 2;
      }
      port = Number(val);
    } else if (arg.startsWith('--port=')) {
      const val = arg.slice('--port='.length);
      if (!/^\d+$/.test(val)) {
        console.error('error: --port requires an integer');
        return 2;
      }
      port = Number(val);
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: cadllm serve [file.cnl] [--port 5170]');
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(`error: unknown option ${arg}`);
      return 2;
    } else if (!open) {
      open = arg;
    } else {
      console.error(`error: unexpected argument ${arg}`);
      return 2;
    }
  }

  const server = await startServer({ port, ...(open ? { open } : {}) });
  console.log(`cadllm serve listening at ${server.url}`);

  await new Promise<void>(resolveStop => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolveStop();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  await server.close();
  return 0;
}
