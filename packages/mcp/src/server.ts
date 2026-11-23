// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Resvg } from '@resvg/resvg-js';
import { errorText } from '@cadllm/core';
import type { Engine } from '@cadllm/engine';
import { z } from 'zod';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Text = { content: Content[]; isError?: boolean };

const reply = async (fn: () => string | Content[] | Promise<string | Content[]>): Promise<Text> => {
  try {
    const out = await fn();
    return { content: typeof out === 'string' ? [{ type: 'text', text: out }] : out };
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
      code: z.string().optional().describe('MCU ref sketch'),
    },
  },
  edit: {
    description: 'Apply CNL edit lines atomically (see help topic=edit). Returns the delta and new issues.',
    inputSchema: {
      cnl: z.string().optional().describe('e.g. "R1 res 330; VCC: BAT1.+ R1.1"'),
      tests: z.string().optional().describe('replace [tests] text ("" clears)'),
      code: z.object({ ref: z.string(), text: z.string() }).optional().describe('MCU sketch ("" clears)'),
      dry_run: z.boolean().optional(),
      if_rev: z.number().int().optional(),
    },
  },
  find: {
    description: 'Search parts (q) or describe pins/props by id ("led,74hc00").',
    inputSchema: {
      q: z.string().optional(),
      id: z.string().optional(),
      limit: z.number().int().optional(),
    },
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
  layout: {
    description: 'Auto-place parts in a view (sch/bb/pcb), or route PCB nets (op=route).',
    inputSchema: {
      view: z.enum(['sch', 'bb', 'pcb']),
      op: z.enum(['place', 'route']).optional().describe('pcb: place (default) or route'),
      refs: z.string().optional().describe('only these, e.g. "R1,D1"'),
      nets: z.string().optional().describe('nets for op=route'),
      all: z.boolean().optional().describe('re-place/reroute all'),
    },
  },
  render: {
    description: 'View as a PNG image.',
    inputSchema: {
      view: z.enum(['sch', 'bb', 'pcb']),
      select: z.string().optional().describe('crop to refs: "U1,R2"'),
      width: z.number().int().optional().describe('px, default 800'),
    },
  },
  export: {
    description: 'Export manufacturing or view files.',
    inputSchema: {
      format: z.enum(['gerber', 'drill', 'fab', 'kicad', 'bom', 'pnp', 'svg']),
      view: z.enum(['sch', 'bb', 'pcb']).optional().describe('for svg'),
      path: z.string().optional().describe('output file or dir'),
    },
  },
  history: {
    description: 'undo, redo, or log of recent revisions.',
    inputSchema: { op: z.enum(['undo', 'redo', 'log']), n: z.number().int().optional() },
  },
  help: {
    description: 'Grammar and examples. Start here. Topics: edit sim tests project views examples parts.',
    inputSchema: { topic: z.string().optional() },
  },
  ext: {
    description: 'Plugin tools: list or call.',
    inputSchema: {
      op: z.enum(['list', 'call']),
      name: z.string().optional(),
      args: z.record(z.string(), z.unknown()).optional(),
    },
  },
} as const;

function renderPng(engine: Engine, a: { view: 'sch' | 'bb' | 'pcb'; select?: string; width?: number }): Content[] {
  const select = a.select?.split(/[\s,]+/).filter(Boolean);
  const svg = engine.renderSvg({ view: a.view, ...(select ? { select } : {}) });
  const width = Math.min(Math.max(a.width ?? 800, 200), 2000);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white' }).render().asPng();
  return [{ type: 'text', text: engine.renderSummary(a.view) }, { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }];
}

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
  server.registerTool('check', t.check, () => reply(() => engine.check()));
  server.registerTool('sim', t.sim, a => reply(() => engine.sim(a)));
  server.registerTool('layout', t.layout, a => reply(() => engine.layout(a)));
  server.registerTool('render', t.render, a => reply(() => renderPng(engine, a)));
  server.registerTool('export', t.export, a => reply(() => engine.export(a)));
  server.registerTool('history', t.history, a => reply(() => engine.history(a)));
  server.registerTool('help', t.help, a => reply(() => engine.help(a)));
  server.registerTool('ext', t.ext, a => reply(() => engine.ext(a)));
  return server;
}
