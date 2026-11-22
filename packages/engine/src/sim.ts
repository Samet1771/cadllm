// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, CadErrors, errorText, parseSI, type Query } from '@cadllm/core';
import { parseCnl, type TestAnalysis, type TestBlock, type TestExpect } from '@cadllm/dsl';
import { formatOp, formatSI, operatingPoint, type OpResult } from '@cadllm/sim-analog';
import {
  clockStimulus, formatTransitions, formatTruthTable, logicModels, simulate,
  truthTable, type Logic, type StimulusEvent, type Trace,
} from '@cadllm/sim-digital';

interface Outcome {
  /** Result text shown to the caller. */
  text: string;
  /** One line per expect: "PASS …" / "FAIL …". */
  checks: string[];
}

const list = (s: string | undefined): string[] => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

/** Parse test-body text ("dc; expect I(D1) < 20m") into test blocks. Line numbers refer to `text`. */
export function parseTests(text: string, adhocName?: string): TestBlock[] {
  const head = adhocName === undefined ? '' : `test "${adhocName.replace(/"/g, "'")}"\n`;
  const offset = adhocName === undefined ? 3 : 4;
  try {
    return parseCnl(`cnl 1\n[circuit]\n[tests]\n${head}${text}`).tests;
  } catch (err) {
    if (err instanceof CadErrors) {
      throw new CadErrors(err.errors.map(e => new CadError(e.code, e.message.replace(/^line (\d+)/, (_, n) => `line ${Math.max(1, Number(n) - offset)}`), e.hint)));
    }
    throw err;
  }
}

function hasLogicIc(q: Query): boolean {
  return q.components().some(c => q.parts.get(c.part)?.sim?.some(s => s.kind === 'logic' && logicModels.get(s.ref) && !logicModels.get(s.ref)!.role));
}

function probeNet(q: Query, probe: string): string {
  if (probe.includes('.')) {
    const pin = q.resolvePin(probe);
    const net = q.netOfPin(pin.key);
    if (!net) throw new CadError('invalid', `pin ${probe} is unconnected`);
    return net.name;
  }
  return q.requireNet(probe).name;
}

function lookup(rec: Record<string, number>, key: string): number | undefined {
  if (key in rec) return rec[key];
  const k = Object.keys(rec).find(x => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : rec[k];
}

function opValue(q: Query, r: OpResult, probe: string): number {
  const m = probe.match(/^([VI])\(([^)]+)\)$/i);
  if (!m) throw new CadError('invalid', `bad probe ${probe}`, 'use V(NET), V(REF.PIN) or I(REF)');
  const target = m[2]!.trim();
  if (m[1]!.toUpperCase() === 'I') {
    const ref = q.requireComponent(target).ref;
    const v = lookup(r.i, ref);
    if (v === undefined) throw new CadError('invalid', `no current for ${ref}`, 'currents exist for two-pin parts and sources');
    return v;
  }
  const v = lookup(r.v, probeNet(q, target));
  if (v === undefined) throw new CadError('unknown_net', `no voltage for ${target}`);
  return v;
}

function runOp(q: Query, a: TestAnalysis, expects: TestExpect[]): Outcome {
  let logic: Record<string, Logic> | undefined;
  if (hasLogicIc(q)) logic = simulate(q, { until: 1 }).final;
  const r = operatingPoint(q, logic ? { logic } : {});
  const probes = list(a.args.probes);
  for (const e of expects) if (e.kind !== 'table' && !probes.some(p => p.toUpperCase() === e.probe.toUpperCase())) probes.push(e.probe);
  const checks = expects.map(e => {
    if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
    const got = opValue(q, r, e.probe);
    return checkNumber(e, got);
  });
  const warn = r.warnings.length ? `\nwarn: ${r.warnings.join(' · ')}` : '';
  return { text: `${r.converged ? '' : 'NOT CONVERGED '}${formatOp(r, probes.length ? probes : undefined, q)}${warn}`, checks };
}

/** Enough digits (in formatSI's prefix) that a value rounding onto a bound no longer looks equal to it. */
function precise(v: number, bounds: number[]): string {
  const prefix = formatSI(v).match(/[a-zA-Z]*$/)![0];
  const scale = parseSI(`1${prefix}`) ?? 1;
  for (let p = 4; ; p++) {
    const s = Number((v / scale).toPrecision(p));
    if (p >= 12 || bounds.every(b => s * scale !== b)) return `${s}${prefix}`;
  }
}

function checkNumber(e: Exclude<TestExpect, { kind: 'table' }>, got: number): string {
  const bounds = e.kind === 'range' ? [e.min, e.max] : [e.value];
  const g = bounds.some(b => formatSI(b) === formatSI(got)) ? precise(got, bounds) : formatSI(got);
  if (e.kind === 'range') {
    const ok = got >= e.min && got <= e.max;
    return `${ok ? 'PASS' : 'FAIL'} ${e.probe} ${g} ${ok ? 'in' : 'not in'} ${e.minRaw}..${e.maxRaw}`;
  }
  const tol = Math.max(Math.abs(e.value) * 1e-3, 1e-12);
  const ok = e.op === '<' ? got < e.value : e.op === '<=' ? got <= e.value : e.op === '>' ? got > e.value : e.op === '>=' ? got >= e.value : Math.abs(got - e.value) <= tol;
  return `${ok ? 'PASS' : 'FAIL'} ${e.probe} ${g} ${ok ? '' : 'not '}${e.op} ${e.raw}`.replace('  ', ' ');
}

function checkTable(e: TestExpect, rows: { in: string[]; out: string[] }[]): string {
  if (e.kind !== 'table') return `FAIL line ${e.line}: logic results need "expect table"`;
  const bad: string[] = [];
  for (const want of e.rows) {
    const got = rows.find(r => r.in.join(' ') === want.inputs.join(' '));
    if (!got) bad.push(`${want.inputs.join(' ')}: no such row`);
    else if (got.out.join(' ') !== want.outputs.join(' ')) bad.push(`${want.inputs.join(' ')} -> ${got.out.join(' ')} (want ${want.outputs.join(' ')})`);
  }
  return bad.length ? `FAIL table: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` … ${bad.length - 4} more` : ''}` : `PASS table ${e.rows.length} rows`;
}

function sampleAt(trace: Trace, net: string, t: number): Logic {
  let v: Logic = 'Z';
  for (const ch of trace.changes) {
    if (ch.t > t) break;
    if (ch.net === net) v = ch.v;
  }
  return v;
}

function runLogic(q: Query, a: TestAnalysis, expects: TestExpect[]): Outcome {
  const inputs = list(a.args.in);
  const outs = list(a.args.out ?? a.args.probes);
  if (inputs.length) {
    if (!outs.length) throw new CadError('invalid', 'logic in=… needs out=…', 'e.g. logic in=SW1,SW2 out=U1.1Y');
    const tt = truthTable(q, inputs, outs);
    const rows = tt.rows.map(r => ({ in: r.in, out: r.out }));
    return { text: formatTruthTable(tt), checks: expects.map(e => checkTable(e, rows)) };
  }

  const clock = a.args.clock;
  if (clock) {
    const period = parseSI(a.args.period ?? '1u');
    const cycles = Number(a.args.cycles ?? '4');
    if (period === undefined || period <= 0) throw new CadError('invalid', `bad period ${a.args.period}`);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 256) throw new CadError('invalid', `bad cycles ${a.args.cycles}`, 'cycles=1..256');
    const stim: StimulusEvent[] = [];
    for (const r of list(a.args.reset)) {
      stim.push({ t: 0.1 * period, ref: r, state: 'closed' }, { t: 0.5 * period, ref: r, state: 'open' });
    }
    stim.push(...clockStimulus(clock, period, cycles, period));
    const trace = simulate(q, { until: (cycles + 1) * period, stimulus: stim });
    if (a.positional.includes('trace')) {
      const probes = outs.length ? outs : [clock];
      return { text: formatTransitions(trace, probes, q), checks: expects.map(e => checkTable(e, [])) };
    }
    if (!outs.length) throw new CadError('invalid', 'logic clock=… needs out=…', 'e.g. logic clock=SW1 reset=SW2 cycles=4 out=Q1,Q0');
    const nets = outs.map(o => probeNet(q, o));
    const rows: { in: string[]; out: string[] }[] = [];
    for (let n = 0; n <= cycles; n++) {
      const t = n === 0 ? 0.9 * period : period * n + 0.75 * period;
      rows.push({ in: [String(n)], out: nets.map(net => sampleAt(trace, net, t)) });
    }
    const w = Math.max(1, String(cycles).length);
    const text = [`${'n'.padEnd(w)} -> ${outs.join(' ')}`, ...rows.map(r => `${r.in[0]!.padEnd(w)} -> ${r.out.map((v, i) => v.padEnd(outs[i]!.length)).join(' ').trimEnd()}`)].join('\n');
    const warn = trace.warnings.length ? `\nwarn: ${trace.warnings.join(' · ')}` : '';
    return { text: text + warn, checks: expects.map(e => checkTable(e, rows)) };
  }

  const trace = simulate(q, { until: 1 });
  const probes = outs.length ? outs : q.nets().map(n => n.name);
  const vals = probes.map(p => `${p}=${trace.final[probeNet(q, p)] ?? 'Z'}`);
  const rows = [{ in: [] as string[], out: probes.map(p => trace.final[probeNet(q, p)] ?? 'Z') }];
  const warn = trace.warnings.length ? `\nwarn: ${trace.warnings.join(' · ')}` : '';
  return { text: vals.join(' ') + warn, checks: expects.map(e => checkTable(e, rows)) };
}

/** Run one analysis plus its expects. */
export function runAnalysis(q: Query, a: TestAnalysis | undefined, expects: TestExpect[]): Outcome {
  if (!a) {
    if (expects.some(e => e.kind === 'table')) throw new CadError('invalid', 'expect table needs an analysis line', 'start with logic in=… out=…');
    a = { kind: 'dc', args: {}, positional: [], line: 0 };
  }
  switch (a.kind) {
    case 'dc':
    case 'op':
      return runOp(q, a, expects);
    case 'logic':
      return runLogic(q, a, expects);
    default:
      throw new CadError('invalid', `${a.kind} analysis is not available yet`, 'use dc (or op) and logic');
  }
}

const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Run the file's [tests]. One line per test; failures carry the failing checks. */
export function runFileTests(q: Query, testsText: string | undefined, pattern = '*'): { text: string; passed: number; failed: number } {
  const tests = testsText ? parseTests(testsText) : [];
  const re = glob(pattern);
  const picked = tests.filter(t => re.test(t.name));
  if (!picked.length) {
    const names = tests.map(t => `"${t.name}"`).join(' ');
    throw new CadError('invalid', tests.length ? `no test matches "${pattern}"` : 'this project has no tests', tests.length ? `tests: ${names}` : 'add them with edit tests="…"');
  }
  const lines: string[] = [];
  let passed = 0;
  for (const t of picked) {
    try {
      const out = runAnalysis(q, t.analysis, t.expects);
      const fails = out.checks.filter(c => c.startsWith('FAIL'));
      if (!t.expects.length) fails.push('FAIL no expect lines');
      if (fails.length) lines.push(`FAIL "${t.name}": ${fails.map(f => f.slice(5)).join(' · ')}`);
      else { passed++; lines.push(`PASS "${t.name}"`); }
    } catch (err) {
      lines.push(`FAIL "${t.name}": ${errorText(err)}`);
    }
  }
  const failed = picked.length - passed;
  lines.sort((a, b) => (a.startsWith('FAIL') === b.startsWith('FAIL') ? 0 : a.startsWith('FAIL') ? -1 : 1));
  lines.unshift(`${picked.length} tests: ${passed} pass${failed ? ` ${failed} fail` : ''}`);
  return { text: lines.join('\n'), passed, failed };
}

/** Run an ad-hoc "sim" command: test-body text with one analysis and optional expects. */
export function runAdhoc(q: Query, run: string): string {
  const [t] = parseTests(run, 'sim');
  const out = runAnalysis(q, t!.analysis, t!.expects);
  return [out.text, ...out.checks].join('\n');
}
