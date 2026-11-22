// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { errorText } from '@cadllm/core';
import { Engine } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { createServer } from '@cadllm/mcp';
import { compileSketch } from '@cadllm/sim-mcu';

/** Rough token estimate (≈4 chars/token for English and code). Good enough to catch regressions. */
export const tokens = (s: string): number => Math.ceil(s.length / 4);

interface Step { tool: string; args: Record<string, unknown> }
interface StepOut { tool: string; text: string; imgTokens: number }
interface Task {
  name: string;
  steps: Step[];
  pass: (outputs: StepOut[]) => boolean;
  skipIf?: () => Promise<string | undefined>;
}

const LED_CNL = 'BAT1 battery 5; R1 res 150; D1 led red\nVCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-';

async function mcuUnavailableReason(): Promise<string | undefined> {
  try {
    await compileSketch('void setup() {}\nvoid loop() {}');
    return undefined;
  } catch (err) {
    const msg = errorText(err);
    if (/not implemented|arduino-cli/i.test(msg)) return msg;
    return undefined;
  }
}

function pngImageTokens(base64: string): number {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 24) return 0;
  return Math.ceil((buf.readUInt32BE(16) * buf.readUInt32BE(20)) / 750);
}

/** The M0 goal tasks (FOUNDATION §11), M1 layout/render task, and M2 blink task. */
export const TASKS: Task[] = [
  {
    name: 'led: 5V LED, prove I < 20 mA',
    steps: [
      { tool: 'find', args: { q: 'led' } },
      { tool: 'edit', args: { cnl: LED_CNL } },
      { tool: 'sim', args: { run: 'dc probes=I(D1)' } },
      { tool: 'edit', args: { cnl: '~R1 resistance=220' } },
      { tool: 'sim', args: { run: 'dc; expect I(D1) < 20m' } },
    ],
    pass: outs => {
      const last = outs.at(-1)?.text ?? '';
      return last.includes('PASS') && !last.includes('FAIL');
    },
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
    pass: outs => {
      const last = outs.at(-1)?.text ?? '';
      return last.includes('PASS table') && !last.includes('FAIL');
    },
  },
  {
    name: 'layout: place the LED circuit on both views and look at it',
    steps: [
      { tool: 'edit', args: { cnl: LED_CNL } },
      { tool: 'layout', args: { view: 'sch' } },
      { tool: 'layout', args: { view: 'bb' } },
      { tool: 'render', args: { view: 'bb', width: 600 } },
    ],
    pass: outs =>
      outs.filter(o => o.tool === 'layout').every(o => !/\berr\b/.test(o.text))
      && outs.some(o => o.tool === 'render' && o.imgTokens > 0),
  },
  {
    name: 'blink: write the sketch, run it, verify the period',
    skipIf: mcuUnavailableReason,
    steps: [
      {
        tool: 'edit',
        args: {
          cnl: 'U1 arduino_uno; R1 res 220; D1 led red\nD13: U1.D13 R1.1; LA: R1.2 D1.A; GND: D1.K U1.GND',
          code: {
            ref: 'U1',
            text: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(1000); digitalWrite(13, LOW); delay(1000); }',
          },
        },
      },
      { tool: 'sim', args: { run: 'run 4s probes=D13; expect period(D13) 1.9s..2.1s' } },
    ],
    pass: outs => {
      const last = outs.at(-1)?.text ?? '';
      return last.includes('PASS') && !last.includes('FAIL');
    },
  },
];

export interface BenchResult {
  schemaTokens: number;
  tools: number;
  tasks: { name: string; calls: number; inTokens: number; outTokens: number; imgTokens: number; ok: boolean; skipped?: string; transcript: string[] }[];
}

export async function runBench(): Promise<BenchResult> {
  const library = loadLibrary([builtinPartsDir]);
  let schemaTokens = 0;
  let toolsCount = 0;
  const tasks: BenchResult['tasks'] = [];

  for (const task of TASKS) {
    const engine = new Engine({ library });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(engine).connect(a);
    const client = new Client({ name: 'bench', version: '0' });
    await client.connect(b);
    try {
      if (toolsCount === 0) {
        const { tools } = await client.listTools();
        toolsCount = tools.length;
        schemaTokens = tokens(JSON.stringify(tools));
      }
      const skipped = task.skipIf ? await task.skipIf() : undefined;
      if (skipped) {
        tasks.push({ name: task.name, calls: 0, inTokens: 0, outTokens: 0, imgTokens: 0, ok: true, skipped, transcript: [`SKIP: ${skipped}`] });
        continue;
      }
      let inTokens = 0;
      let outTokens = 0;
      let imgTokens = 0;
      let ok = true;
      const outputs: StepOut[] = [];
      const transcript: string[] = [];
      for (const s of task.steps) {
        const res = await client.callTool({ name: s.tool, arguments: s.args });
        const content = res.content as { type: string; text?: string; data?: string }[];
        const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
        const stepImg = content.filter(c => c.type === 'image' && c.data).reduce((sum, c) => sum + pngImageTokens(c.data!), 0);
        inTokens += tokens(JSON.stringify({ name: s.tool, arguments: s.args }));
        outTokens += tokens(text);
        imgTokens += stepImg;
        if (res.isError) ok = false;
        outputs.push({ tool: s.tool, text, imgTokens: stepImg });
        transcript.push(`> ${s.tool} ${JSON.stringify(s.args)}\n${text}${stepImg ? `\n[image ≈${stepImg} tok]` : ''}`);
      }
      tasks.push({ name: task.name, calls: task.steps.length, inTokens, outTokens, imgTokens, ok: ok && task.pass(outputs), transcript });
    } finally {
      await client.close();
    }
  }
  return { schemaTokens, tools: toolsCount, tasks };
}

export function formatBench(r: BenchResult): string {
  const lines = [`tools ${r.tools} · schema ≈${r.schemaTokens} tok`];
  const w = Math.max(...r.tasks.map(t => t.name.length));
  for (const t of r.tasks) {
    if (t.skipped) {
      lines.push(`SKIP ${t.name.padEnd(w)}  (${t.skipped})`);
      continue;
    }
    const img = t.imgTokens ? `  img ≈${t.imgTokens}` : '';
    lines.push(`${t.ok ? 'PASS' : 'FAIL'} ${t.name.padEnd(w)}  calls ${t.calls}  in ≈${t.inTokens}  out ≈${t.outTokens}  total ≈${t.inTokens + t.outTokens} tok${img}`);
  }
  return lines.join('\n');
}
