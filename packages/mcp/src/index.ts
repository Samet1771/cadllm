// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Engine } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { createServer } from './server.ts';

export { createServer, TOOLS } from './server.ts';

/** Serve MCP over stdio until stdin closes. */
export async function serveStdio(opts: { root?: string; partsDirs?: string[] } = {}): Promise<void> {
  const library = loadLibrary([builtinPartsDir, ...(opts.partsDirs ?? [])]);
  const engine = new Engine({ library, ...(opts.root ? { root: opts.root } : {}) });
  await createServer(engine).connect(new StdioServerTransport());
}
