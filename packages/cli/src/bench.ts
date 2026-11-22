// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Engine } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { createServer } from '@cadllm/mcp';

/** Rough token estimate (≈4 chars/token for English and code). Good enough to catch regressions. */
export const tokens = (s: string): number => Math.ceil(s.length / 4);

interface Step { tool: string; args: Record<string, unknown> }
interface Task { name: string; steps: Step[]; pass: (last: string) => boolean }

/** The two M0 goal tasks (FOUNDATION §11), scripted the way an agent would do them. */
export const TASKS: Task[] = [
  {
    name: 'led: 5V LED, prove I < 20 mA',
    steps: [
      { tool: 'find', args: { q: 'led' } },
      { tool: 'edit', args: { cnl: 'BAT1 battery 5; R1 res 150; D1 led red\nVCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-' } },
      { tool: 'sim', args: { run: 'dc probes=I(D1)' } },
      { tool: 'edit', args: { cnl: '~R1 resistance=220' } },
      { tool: 'sim', args: { run: 'dc; expect I(D1) < 20m' } },
    ],
    pass: last => last.includes('PASS') && !last.includes('FAIL'),
  },
  {
    name: 'counter: 2-bit counter, verify sequence',
    steps: [
      { tool: 'project', args: { op: 'new', name: 'ctr' } },
      { tool: 'part', args: { id: '74hc74' } },
      { tool: 'edit', args: { cnl: `BAT1 battery 5; U1 74hc74; SW1 button; R1 res 10k; SW2 button; R2 res 10k
VCC: BAT1.+ U1.VCC U1.1PRE U1.2PRE SW1.1 R2.2; GND: BAT1.- U1.GND R1.2 SW2.2
CLK: SW1.2 R1.1 U1.1CLK; RST: U1.1CLR U1.2CLR R2.1 SW2.1
Q0: U1.1Q; Q0N: U1.1QN U1.1D U1.2CLK; Q1: U1.2Q; Q1N: U1.2QN U1.2D` } },
      { tool: 'sim', args: { run: 'logic clock=SW1 reset=SW2 cycles=4 out=Q1,Q0; expect table; 1 -> 0 1; 2 -> 1 0; 3 -> 1 1; 4 -> 0 0' } },
    ],
    pass: last => last.includes('PASS table') && !last.includes('FAIL'),
  },
];

export interface BenchResult {
  schemaTokens: number;
  tools: number;
  tasks: { name: string; calls: number; inTokens: number; outTokens: number; ok: boolean; transcript: string[] }[];
}

export async function runBench(): Promise<BenchResult> {
  const engine = new Engine({ library: loadLibrary([builtinPartsDir]) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(engine).connect(a);
  const client = new Client({ name: 'bench', version: '0' });
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const result: BenchResult = { schemaTokens: tokens(JSON.stringify(tools)), tools: tools.length, tasks: [] };
    for (const task of TASKS) {
      let inTokens = 0;
      let outTokens = 0;
      let last = '';
      let ok = true;
      const transcript: string[] = [];
      for (const s of task.steps) {
        const res = await client.callTool({ name: s.tool, arguments: s.args });
        const text = (res.content as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n');
        inTokens += tokens(JSON.stringify({ name: s.tool, arguments: s.args }));
        outTokens += tokens(text);
        if (res.isError) ok = false;
        last = text;
        transcript.push(`> ${s.tool} ${JSON.stringify(s.args)}\n${text}`);
      }
      result.tasks.push({ name: task.name, calls: task.steps.length, inTokens, outTokens, ok: ok && task.pass(last), transcript });
    }
    return result;
  } finally {
    await client.close();
  }
}

export function formatBench(r: BenchResult): string {
  const lines = [`tools ${r.tools} · schema ≈${r.schemaTokens} tok`];
  const w = Math.max(...r.tasks.map(t => t.name.length));
  for (const t of r.tasks) {
    lines.push(`${t.ok ? 'PASS' : 'FAIL'} ${t.name.padEnd(w)}  calls ${t.calls}  in ≈${t.inTokens}  out ≈${t.outTokens}  total ≈${t.inTokens + t.outTokens} tok`);
  }
  return lines.join('\n');
}
