#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { errorText } from '@cadllm/core';
import { Engine } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { serveStdio } from '@cadllm/mcp';
import { formatBench, runBench } from './bench.ts';

const USAGE = `usage:
  cadllm mcp                     MCP server on stdio
  cadllm test <file.cnl> [name]  run the file's [tests] (name may use *)
  cadllm bench [-v]              token benchmark of the M0 goal tasks`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'mcp':
      await serveStdio();
      return -1;
    case 'test': {
      const [file, pattern] = rest;
      if (!file) break;
      const engine = new Engine({ library: loadLibrary([builtinPartsDir]), source: 'user' });
      engine.project({ op: 'open', path: file });
      const r = engine.test(pattern);
      console.log(r.text);
      return r.failed ? 1 : 0;
    }
    case 'bench': {
      const r = await runBench();
      if (rest.includes('-v')) for (const t of r.tasks) console.log(`## ${t.name}\n${t.transcript.join('\n')}\n`);
      console.log(formatBench(r));
      return r.tasks.every(t => t.ok) ? 0 : 1;
    }
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  code => { if (code >= 0) process.exitCode = code; },
  err => { console.error(`error: ${errorText(err)}`); process.exitCode = 1; },
);
