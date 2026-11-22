// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>CadLLM</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">
  <h1>CadLLM UI not built</h1>
  <p>Run <code>npm run build -w @cadllm/ui</code> and reload this page.</p>
</body>
</html>
`;

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Serve built UI assets from `distDir`, or a build-instruction page if `distDir/index.html` is missing. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const root = resolve(distDir);
  const indexFile = resolve(root, 'index.html');
  if (!existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : FALLBACK_HTML);
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (pathname.includes('\0')) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const relPath = pathname.replace(/^\/+/, '');
  let filePath = relPath ? resolve(root, relPath) : indexFile;
  if (!isInside(root, filePath)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = resolve(filePath, 'index.html');
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (!extname(relPath)) {
      filePath = indexFile;
    } else {
      sendText(res, 404, 'Not Found');
      return;
    }
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const data = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.byteLength });
  res.end(req.method === 'HEAD' ? undefined : data);
}
