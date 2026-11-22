// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorText } from '@cadllm/core';
import type { Engine } from '@cadllm/engine';
import { z } from 'zod';

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };

const reply = (fn: () => string): Text => {
  try {
    return { content: [{ type: 'text', text: fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${errorText(err)}` }], isError: true };
  }
};

/** Tool names, descriptions and input schemas. Kept terse: every byte here is paid on every request. */
export const TOOLS = {
  project: {
    description: 'Projects: new open save list use fork merge close. The first edit creates "untitled".',
    inputSchema: {
      op: z.enum(['new', 'open', 'save', 'list', 'use', 'fork', 'merge', 'close']),
      name: z.string().optional(),
      path: z.string().optional().describe('.cnl file'),
    },
  },
  read: {
    description: 'Circuit as CNL text. detail 0=summary 1=lines 2=+default props.',
    inputSchema: {
      select: z.string().optional().describe('refs/nets: "U1,R2,net:VCC"'),
      detail: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      since: z.number().int().optional().describe('only changes after this rev'),
      place: z.boolean().optional().describe('include @view placements'),
      tests: z.boolean().optional().describe('include [tests]'),
    },
  },
  edit: {
    description: 'Apply CNL edit lines atomically (see help topic=edit). Returns the delta and new issues.',
    inputSchema: {
      cnl: z.string().optional().describe('e.g. "R1 res 330; VCC: BAT1.+ R1.1"'),
      tests: z.string().optional().describe('replace [tests] text ("" clears)'),
      dry_run: z.boolean().optional(),
      if_rev: z.number().int().optional(),
    },
  },
  find: {
    description: 'Search the part library.',
    inputSchema: { q: z.string(), limit: z.number().int().optional() },
  },
  part: {
    description: 'Pins, props and sim models of parts.',
    inputSchema: { id: z.string().describe('one or more ids: "led,74hc00"') },
  },
  check: {
    description: 'Electrical rule check: errors and warnings.',
    inputSchema: {},
  },
  sim: {
    description: 'Simulate and assert (see help topic=sim). "test" runs project tests.',
    inputSchema: {
      run: z.string().describe('"dc; expect I(D1) < 20m" · "logic in=SW1 out=Y" · "test"'),
    },
  },
  history: {
    description: 'undo, redo, or log of recent revisions.',
    inputSchema: { op: z.enum(['undo', 'redo', 'log']), n: z.number().int().optional() },
  },
  help: {
    description: 'Grammar and examples. Start here. Topics: edit sim tests project examples parts.',
    inputSchema: { topic: z.string().optional() },
  },
} as const;

export function createServer(engine: Engine, version = '0.0.0'): McpServer {
  const server = new McpServer(
    { name: 'cadllm', version },
    { instructions: 'CadLLM designs and simulates circuits as text (CNL). Call help once for the grammar; results are compact text with rev=N.' },
  );
  const t = TOOLS;
  server.registerTool('project', t.project, a => reply(() => engine.project(a)));
  server.registerTool('read', t.read, a => reply(() => engine.read(a)));
  server.registerTool('edit', t.edit, a => reply(() => engine.edit(a)));
  server.registerTool('find', t.find, a => reply(() => engine.find(a)));
  server.registerTool('part', t.part, a => reply(() => engine.part(a)));
  server.registerTool('check', t.check, () => reply(() => engine.check()));
  server.registerTool('sim', t.sim, a => reply(() => engine.sim(a)));
  server.registerTool('history', t.history, a => reply(() => engine.history(a)));
  server.registerTool('help', t.help, a => reply(() => engine.help(a)));
  return server;
}
