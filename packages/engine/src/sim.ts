// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, CadErrors, errorText, naturalCompare, parseSI, type Query } from '@cadllm/core';
import { codeMetaKey, parseCnl, type ExpectMeasure, type TestAnalysis, type TestBlock, type TestExpect } from '@cadllm/dsl';
import { formatOp, formatSI, operatingPoint, type OpResult } from '@cadllm/sim-analog';
import {
  clockStimulus, formatTransitions, formatTruthTable, logicModels, simulate,
  truthTable, type Logic, type StimulusEvent, type Trace,
} from '@cadllm/sim-digital';
import { compileSketch } from '@cadllm/sim-mcu';
import { formatMixed, runMixed, type MixedTrace } from '@cadllm/sim-mixed';
import type { SpiceResult, SpiceSweep } from '@cadllm/sim-spice';

interface Outcome {
  /** Result text shown to the caller. */
  text: string;
  /** One line per expect: "PASS …" / "FAIL …". */
  checks: string[];
}

interface Series {
  t: Float64Array;
  y: Float64Array;
  stepHold: boolean;
  tEnd: number;
  invalid?: string;
}

const OWN_SPICE_REFS = new Set(['R', 'POT', 'V', 'VSYM', 'GND', 'SW', 'C', 'L', 'D1N4148', 'DZ', 'LED']);
const sketchCache = new Map<string, string>();

const list = (s: string | undefined): string[] => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

function uniqueProbes(base: string[], expects: TestExpect[]): string[] {
  const out = [...base];
  for (const e of expects) {
    if (e.kind !== 'table' && !out.some(p => p.toUpperCase() === e.probe.toUpperCase())) {
      out.push(e.probe);
    }
  }
  return out;
}

async function getCompiledHex(source: string): Promise<string> {
  const cached = sketchCache.get(source);
  if (cached !== undefined) return cached;
  const res = await compileSketch(source);
  sketchCache.set(source, res.hex);
  return res.hex;
}

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

function needsSpiceOp(q: Query): boolean {
  return q.components().some(c => {
    const sr = q.part(c).sim?.find(s => s.kind === 'spice')?.ref;
    return sr !== undefined && !OWN_SPICE_REFS.has(sr);
  });
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

function lookup<T>(rec: Record<string, T>, key: string): T | undefined {
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

function spiceVectorKey(q: Query, res: SpiceResult, probe: string, isAc: boolean): string {
  const map = isAc && res.complex ? res.complex : res.vectors;
  const direct = Object.keys(map).find(k => k.toUpperCase() === probe.toUpperCase());
  if (direct) return direct;
  const m = probe.trim().match(/^([VI])\(([^)]+)\)$/i);
  if (m) {
    const kind = m[1]!.toUpperCase();
    const target = m[2]!.trim();
    if (kind === 'V') {
      const net = probeNet(q, target);
      const want = `V(${net})`;
      const hit = Object.keys(map).find(k => k.toUpperCase() === want.toUpperCase() || k.toUpperCase() === net.toUpperCase());
      if (hit) return hit;
    } else {
      const ref = q.requireComponent(target).ref;
      const want = `I(${ref})`;
      const hit = Object.keys(map).find(k => k.toUpperCase() === want.toUpperCase() || k.toUpperCase() === ref.toUpperCase());
      if (hit) return hit;
    }
  }
  throw new CadError('invalid', `probe ${probe} not found in SPICE output`);
}

function extractSpiceSeries(q: Query, res: SpiceResult, probe: string, isAc: boolean): Series {
  const key = spiceVectorKey(q, res, probe, isAc);
  const t = res.scale.values;
  let y: Float64Array;
  if (isAc && res.complex?.[key]) {
    const { re, im } = res.complex[key]!;
    y = new Float64Array(re.length);
    for (let i = 0; i < re.length; i++) y[i] = Math.hypot(re[i]!, im[i]!);
  } else {
    const raw = res.vectors[key]!;
    if (isAc) {
      y = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) y[i] = Math.abs(raw[i]!);
    } else {
      y = raw;
    }
  }
  return { t, y, stepHold: false, tEnd: t[t.length - 1] ?? 0 };
}

function extractMixedSeries(q: Query, trace: MixedTrace, probe: string, until: number): Series {
  if (/^[VI]\([^)]+\)$/i.test(probe.trim())) {
    const vals: { t: number; v: number }[] = [];
    for (const s of trace.analog) {
      const v = lookup(s.values, probe);
      if (v !== undefined) vals.push({ t: s.t, v });
    }
    if (vals.length === 0) {
      throw new CadError('invalid', `probe ${probe} has no samples`);
    }
    return {
      t: Float64Array.from(vals, x => x.t),
      y: Float64Array.from(vals, x => x.v),
      stepHold: true,
      tEnd: until,
    };
  }
  const net = probeNet(q, probe);
  const pts = trace.changes.filter(c => c.net === net);
  if (pts.length === 0) {
    return { t: new Float64Array([0]), y: new Float64Array([Number.NaN]), stepHold: true, tEnd: until, invalid: 'Z' };
  }
  return {
    t: Float64Array.from(pts, p => p.t),
    y: Float64Array.from(pts, p => (p.v === '1' ? 1 : p.v === '0' ? 0 : Number.NaN)),
    stepHold: true,
    tEnd: until,
  };
}

function findCrossings(s: Series): { rising: number[]; falling: number[]; yMin: number; yMax: number } {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < s.y.length; i++) {
    const v = s.y[i]!;
    if (!Number.isFinite(v)) return { rising: [], falling: [], yMin: Number.NaN, yMax: Number.NaN };
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  const span = yMax - yMin;
  if (span <= 1e-9 || s.y.length < 2) return { rising: [], falling: [], yMin, yMax };

  const mid = (yMin + yMax) / 2;
  const lo = yMin + 0.4 * span;
  const hi = yMin + 0.6 * span;
  const rising: number[] = [];
  const falling: number[] = [];

  let state: 'low' | 'mid' | 'high' = s.y[0]! >= hi ? 'high' : s.y[0]! <= lo ? 'low' : 'mid';
  const interpMid = (idx: number, dir: 1 | -1): number => {
    if (s.stepHold) return s.t[idx]!;
    for (let j = idx; j > 0; j--) {
      const a = s.y[j - 1]!;
      const b = s.y[j]!;
      if ((dir === 1 && a <= mid && b >= mid) || (dir === -1 && a >= mid && b <= mid)) {
        const denom = b - a;
        const frac = Math.abs(denom) > 1e-18 ? (mid - a) / denom : 0;
        return s.t[j - 1]! + frac * (s.t[j]! - s.t[j - 1]!);
      }
    }
    return s.t[idx]!;
  };

  for (let i = 1; i < s.y.length; i++) {
    const v = s.y[i]!;
    if (state === 'low' && v >= hi) {
      rising.push(interpMid(i, 1));
      state = 'high';
    } else if (state === 'high' && v <= lo) {
      falling.push(interpMid(i, -1));
      state = 'low';
    } else if (state === 'mid') {
      if (v >= hi) state = 'high';
      else if (v <= lo) state = 'low';
    }
  }
  return { rising, falling, yMin, yMax };
}

function measureEdge(s: Series, risingEdge: boolean): number {
  const { yMin, yMax } = findCrossings(s);
  const span = yMax - yMin;
  if (!Number.isFinite(span) || span <= 1e-9) return Number.NaN;
  const y10 = yMin + 0.1 * span;
  const y90 = yMin + 0.9 * span;
  const interp = (i: number, level: number): number => {
    if (s.stepHold) return s.t[i]!;
    const a = s.y[i - 1]!;
    const b = s.y[i]!;
    const denom = b - a;
    const frac = Math.abs(denom) > 1e-18 ? (level - a) / denom : 0;
    return s.t[i - 1]! + frac * (s.t[i]! - s.t[i - 1]!);
  };

  let tStart: number | undefined;
  for (let i = 1; i < s.y.length; i++) {
    const a = s.y[i - 1]!;
    const b = s.y[i]!;
    if (risingEdge) {
      if (a < y10 && b >= y10) tStart = interp(i, y10);
      if (tStart !== undefined && b >= y90 && a < y90) return interp(i, y90) - tStart;
      if (b < y10) tStart = undefined;
    } else {
      if (a > y90 && b <= y90) tStart = interp(i, y90);
      if (tStart !== undefined && b <= y10 && a > y10) return interp(i, y10) - tStart;
      if (b > y90) tStart = undefined;
    }
  }
  return Number.NaN;
}

function evalMeasure(s: Series, measure: ExpectMeasure | undefined, at?: number): number {
  const n = s.y.length;
  if (n === 0) return Number.NaN;
  for (let i = 0; i < n; i++) {
    if (measure !== 'at' && !Number.isFinite(s.y[i]!)) return Number.NaN;
  }

  switch (measure ?? 'final') {
    case 'at': {
      const target = at ?? 0;
      if (s.stepHold) {
        if (target + 1e-12 < s.t[0]! || target - 1e-12 > s.tEnd) return Number.NaN;
        let idx = 0;
        for (let i = 0; i < n; i++) {
          if (s.t[i]! <= target + 1e-12) idx = i;
          else break;
        }
        return s.y[idx]!;
      }
      if (target < s.t[0]! - 1e-12 || target > s.tEnd + 1e-12) return Number.NaN;
      if (target <= s.t[0]!) return s.y[0]!;
      if (target >= s.t[n - 1]!) return s.y[n - 1]!;
      for (let i = 1; i < n; i++) {
        if (s.t[i]! >= target) {
          const dt = s.t[i]! - s.t[i - 1]!;
          const frac = dt > 0 ? (target - s.t[i - 1]!) / dt : 0;
          return s.y[i - 1]! + frac * (s.y[i]! - s.y[i - 1]!);
        }
      }
      return s.y[n - 1]!;
    }
    case 'min': {
      let m = Infinity;
      for (let i = 0; i < n; i++) if (s.y[i]! < m) m = s.y[i]!;
      return m;
    }
    case 'max': {
      let m = -Infinity;
      for (let i = 0; i < n; i++) if (s.y[i]! > m) m = s.y[i]!;
      return m;
    }
    case 'final':
      return s.y[n - 1]!;
    case 'avg':
    case 'rms': {
      const sq = measure === 'rms';
      const dur = s.tEnd - s.t[0]!;
      if (dur <= 0 || n === 1) return sq ? Math.abs(s.y[0]!) : s.y[0]!;
      let acc = 0;
      if (s.stepHold) {
        for (let i = 0; i < n; i++) {
          const dt = (i + 1 < n ? s.t[i + 1]! : s.tEnd) - s.t[i]!;
          const v = s.y[i]!;
          acc += (sq ? v * v : v) * dt;
        }
      } else {
        for (let i = 1; i < n; i++) {
          const dt = s.t[i]! - s.t[i - 1]!;
          const a = s.y[i - 1]!;
          const b = s.y[i]!;
          acc += (sq ? 0.5 * (a * a + b * b) : 0.5 * (a + b)) * dt;
        }
      }
      const mean = acc / dur;
      return sq ? Math.sqrt(Math.max(0, mean)) : mean;
    }
    case 'period':
    case 'freq': {
      const { rising, falling } = findCrossings(s);
      const pts = rising.length >= 2 ? rising : falling.length >= 2 ? falling : undefined;
      if (!pts) return Number.NaN;
      const period = pts[pts.length - 1]! - pts[pts.length - 2]!;
      if (period <= 0) return Number.NaN;
      return measure === 'period' ? period : 1 / period;
    }
    case 'duty': {
      const { rising, falling, yMin, yMax } = findCrossings(s);
      if (rising.length >= 2) {
        const r0 = rising[rising.length - 2]!;
        const r1 = rising[rising.length - 1]!;
        const f = falling.find(x => x > r0 && x < r1);
        if (f !== undefined && r1 > r0) return (f - r0) / (r1 - r0);
      }
      if (falling.length >= 2) {
        const f0 = falling[falling.length - 2]!;
        const f1 = falling[falling.length - 1]!;
        const r = rising.find(x => x > f0 && x < f1);
        if (r !== undefined && f1 > f0) return (f1 - r) / (f1 - f0);
      }
      const mid = (yMin + yMax) / 2;
      const dur = s.tEnd - s.t[0]!;
      if (dur <= 0 || !Number.isFinite(mid)) return Number.NaN;
      let hiTime = 0;
      for (let i = 0; i < n; i++) {
        const t0 = s.t[i]!;
        const t1 = i + 1 < n ? s.t[i + 1]! : s.tEnd;
        if (s.stepHold) {
          if (s.y[i]! >= mid) hiTime += t1 - t0;
        } else if (i + 1 < n && (s.y[i]! + s.y[i + 1]!) / 2 >= mid) {
          hiTime += t1 - t0;
        }
      }
      return hiTime / dur;
    }
    case 'rise':
      return measureEdge(s, true);
    case 'fall':
      return measureEdge(s, false);
  }
}

function expectSubject(e: Exclude<TestExpect, { kind: 'table' }>): string {
  if (e.measure === 'at') return `${e.probe}@${formatSI(e.at!)}`;
  if (e.measure) return `${e.measure}(${e.probe})`;
  return e.probe;
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

function fmtPercent(v: number, bounds: number[]): string {
  const fmt = (p: number) => `${Number((v * 100).toPrecision(p))}%`;
  const s3 = fmt(3);
  if (!bounds.some(b => `${Number((b * 100).toPrecision(3))}%` === s3)) return s3;
  for (let p = 4; p < 12; p++) {
    const s = Number((v * 100).toPrecision(p));
    if (bounds.every(b => s / 100 !== b)) return `${s}%`;
  }
  return fmt(12);
}

function checkNumber(e: Exclude<TestExpect, { kind: 'table' }>, got: number, reason?: string): string {
  const subj = expectSubject(e);
  if (!Number.isFinite(got)) {
    return `FAIL ${subj} ${reason ?? (e.measure === 'freq' || e.measure === 'period' ? 'not periodic' : 'unavailable')}`;
  }
  const bounds = e.kind === 'range' ? [e.min, e.max] : [e.value];
  const g = e.measure === 'duty'
    ? fmtPercent(got, bounds)
    : bounds.some(b => formatSI(b) === formatSI(got)) ? precise(got, bounds) : formatSI(got);
  if (e.kind === 'range') {
    const ok = got >= e.min && got <= e.max;
    return `${ok ? 'PASS' : 'FAIL'} ${subj} ${g} ${ok ? 'in' : 'not in'} ${e.minRaw}..${e.maxRaw}`;
  }
  const tol = Math.max(Math.abs(e.value) * 1e-3, 1e-12);
  const ok = e.op === '<' ? got < e.value : e.op === '<=' ? got <= e.value : e.op === '>' ? got > e.value : e.op === '>=' ? got >= e.value : Math.abs(got - e.value) <= tol;
  return `${ok ? 'PASS' : 'FAIL'} ${subj} ${g} ${ok ? '' : 'not '}${e.op} ${e.raw}`.replace('  ', ' ');
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

async function runOp(q: Query, a: TestAnalysis, expects: TestExpect[]): Promise<Outcome> {
  const probes = uniqueProbes(list(a.args.probes), expects);
  if (needsSpiceOp(q)) {
    const { op: opSpice } = await import('@cadllm/sim-spice');
    const res = await opSpice(q, probes.length ? { probes } : {});
    const shown = probes.length ? probes : Object.keys(res.vectors).sort(naturalCompare);
    const summary = shown.map(p => {
      const k = spiceVectorKey(q, res, p, false);
      return `${p} ${formatSI(res.vectors[k]![0]!)}`;
    }).join('  ');
    const checks = expects.map(e => {
      if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
      if (e.measure && !['min', 'max', 'avg', 'final', 'rms'].includes(e.measure)) {
        return `FAIL ${expectSubject(e)} needs tran or run`;
      }
      const k = spiceVectorKey(q, res, e.probe, false);
      return checkNumber(e, res.vectors[k]![0]!);
    });
    return { text: summary, checks };
  }

  let logic: Record<string, Logic> | undefined;
  if (hasLogicIc(q)) logic = simulate(q, { until: 1 }).final;
  const r = operatingPoint(q, logic ? { logic } : {});
  const checks = expects.map(e => {
    if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
    const got = opValue(q, r, e.probe);
    return checkNumber(e, got);
  });
  const warn = r.warnings.length ? `\nwarn: ${r.warnings.join(' · ')}` : '';
  return { text: `${r.converged ? '' : 'NOT CONVERGED '}${formatOp(r, probes.length ? probes : undefined, q)}${warn}`, checks };
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

function defaultSpiceProbes(res: SpiceResult): string[] {
  const keys = Object.keys(res.complex ?? res.vectors);
  return keys.filter(k => /^[VI]\(/i.test(k)).sort(naturalCompare);
}

async function runTran(q: Query, a: TestAnalysis, expects: TestExpect[]): Promise<Outcome> {
  let stopRaw = a.args.stop;
  let stepRaw = a.args.step;
  if (a.positional.length === 1) {
    stopRaw = a.positional[0]!;
  } else if (a.positional.length === 2) {
    stepRaw = a.positional[0]!;
    stopRaw = a.positional[1]!;
  } else if (a.positional.length > 2) {
    throw new CadError('invalid', 'tran syntax: tran <stop> [step=…] [probes=…]');
  }
  if (!stopRaw) throw new CadError('invalid', 'tran needs stop duration, e.g. tran 10m');
  const stop = parseSI(stopRaw);
  if (stop === undefined || !Number.isFinite(stop) || stop <= 0) {
    throw new CadError('invalid', `bad tran stop "${stopRaw}"`);
  }
  let step: number | undefined;
  if (stepRaw !== undefined) {
    step = parseSI(stepRaw);
    if (step === undefined || !Number.isFinite(step) || step <= 0) {
      throw new CadError('invalid', `bad tran step "${stepRaw}"`);
    }
  }

  const probes = uniqueProbes(list(a.args.probes), expects);
  const { tran } = await import('@cadllm/sim-spice');
  const res = await tran(q, { stop, ...(step !== undefined ? { step } : {}), ...(probes.length ? { probes } : {}) });
  const shown = probes.length ? probes : defaultSpiceProbes(res);
  const w = Math.max(1, ...shown.map(p => p.length));
  const lines = [`tran ${formatSI(stop)}s ${res.scale.values.length}pts`];
  for (const p of shown) {
    const s = extractSpiceSeries(q, res, p, false);
    const min = evalMeasure(s, 'min');
    const max = evalMeasure(s, 'max');
    const fin = evalMeasure(s, 'final');
    const freq = evalMeasure(s, 'freq');
    const freqStr = Number.isFinite(freq) ? `  freq ${formatSI(freq)}Hz` : '';
    lines.push(`  ${p.padEnd(w)}  min ${formatSI(min)}  max ${formatSI(max)}  final ${formatSI(fin)}${freqStr}`);
  }

  const checks = expects.map(e => {
    if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
    const s = extractSpiceSeries(q, res, e.probe, false);
    return checkNumber(e, evalMeasure(s, e.measure, e.at));
  });
  return { text: lines.join('\n'), checks };
}

function findMinus3dB(freqs: Float64Array, mags: Float64Array, sweep: SpiceSweep): number | undefined {
  let gMax = -Infinity;
  for (let i = 0; i < mags.length; i++) if (mags[i]! > gMax) gMax = mags[i]!;
  if (!Number.isFinite(gMax) || gMax <= 0) return undefined;
  const target = gMax / Math.SQRT2;
  for (let i = 1; i < mags.length; i++) {
    const a = mags[i - 1]!;
    const b = mags[i]!;
    if ((a >= target && b <= target) || (a <= target && b >= target)) {
      const denom = b - a;
      const frac = Math.abs(denom) > 1e-18 ? (target - a) / denom : 0;
      const f0 = freqs[i - 1]!;
      const f1 = freqs[i]!;
      if (sweep !== 'lin' && f0 > 0 && f1 > 0) {
        return f0 * Math.pow(f1 / f0, frac);
      }
      return f0 + frac * (f1 - f0);
    }
  }
  return undefined;
}

async function runAc(q: Query, a: TestAnalysis, expects: TestExpect[]): Promise<Outcome> {
  const sweepRaw = (a.positional[0] ?? a.args.sweep ?? '').toLowerCase();
  const ptsRaw = a.positional[1] ?? a.args.points;
  const startRaw = a.positional[2] ?? a.args.start;
  const stopRaw = a.positional[3] ?? a.args.stop;
  if (!['dec', 'oct', 'lin'].includes(sweepRaw) || !ptsRaw || !startRaw || !stopRaw) {
    throw new CadError('invalid', 'ac syntax: ac <dec|oct|lin> <points> <start> <stop> [probes=…]');
  }
  const sweep = sweepRaw as SpiceSweep;
  const points = Number(ptsRaw);
  const start = parseSI(startRaw);
  const stop = parseSI(stopRaw);
  if (!Number.isInteger(points) || points <= 0) throw new CadError('invalid', `bad ac points "${ptsRaw}"`);
  if (start === undefined || !Number.isFinite(start) || (sweep !== 'lin' ? start <= 0 : start < 0)) {
    throw new CadError('invalid', `bad ac start frequency "${startRaw}"`);
  }
  if (stop === undefined || !Number.isFinite(stop) || stop <= start) {
    throw new CadError('invalid', `bad ac stop frequency "${stopRaw}"`);
  }

  const probes = uniqueProbes(list(a.args.probes), expects);
  const { ac } = await import('@cadllm/sim-spice');
  const res = await ac(q, { sweep, points, start, stop, ...(probes.length ? { probes } : {}) });
  const shown = probes.length ? probes : defaultSpiceProbes(res);
  const w = Math.max(1, ...shown.map(p => p.length));
  const lines = [`ac ${sweep} ${formatSI(start)}Hz..${formatSI(stop)}Hz ${res.scale.values.length}pts`];
  for (const p of shown) {
    const s = extractSpiceSeries(q, res, p, true);
    const gStart = s.y[0]!;
    const gStop = s.y[s.y.length - 1]!;
    const f3db = findMinus3dB(s.t, s.y, sweep);
    const f3dbStr = f3db !== undefined ? `  -3dB ${formatSI(f3db)}Hz` : '';
    lines.push(`  ${p.padEnd(w)}  start ${formatSI(gStart)}  stop ${formatSI(gStop)}${f3dbStr}`);
  }

  const checks = expects.map(e => {
    if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
    const s = extractSpiceSeries(q, res, e.probe, true);
    return checkNumber(e, evalMeasure(s, e.measure, e.at));
  });
  return { text: lines.join('\n'), checks };
}

function parsePressStimulus(raw: string | undefined): StimulusEvent[] {
  if (!raw) return [];
  const out: StimulusEvent[] = [];
  for (const item of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = item.match(/^([^@]+)@([^-]+)(?:-(.+))?$/);
    if (!m) throw new CadError('invalid', `bad press spec "${item}"`, 'use REF@0.5s-1.0s or REF@0.5s');
    const ref = m[1]!.trim();
    const t0 = parseSI(m[2]!.trim());
    if (t0 === undefined || !Number.isFinite(t0) || t0 < 0) {
      throw new CadError('invalid', `bad press start time in "${item}"`);
    }
    out.push({ t: t0, ref, state: 'closed' });
    if (m[3] !== undefined) {
      const t1 = parseSI(m[3]!.trim());
      if (t1 === undefined || !Number.isFinite(t1) || t1 < t0) {
        throw new CadError('invalid', `bad press end time in "${item}"`);
      }
      out.push({ t: t1, ref, state: 'open' });
    }
  }
  return out;
}

async function runMixedAnalysis(q: Query, a: TestAnalysis, expects: TestExpect[]): Promise<Outcome> {
  const durRaw = a.positional[0] ?? a.args.until ?? a.args.dur;
  if (!durRaw) throw new CadError('invalid', 'run needs duration, e.g. run 4s');
  const until = parseSI(durRaw);
  if (until === undefined || !Number.isFinite(until) || until < 0) {
    throw new CadError('invalid', `bad run duration "${durRaw}"`);
  }

  const stimulus = parsePressStimulus(a.args.press);
  const firmware: Record<string, string> = {};
  for (const comp of q.components()) {
    const hasMcu = q.part(comp).sim?.some(s => s.kind === 'mcu');
    if (!hasMcu) continue;
    const code = q.circuit.meta[codeMetaKey(comp.ref)];
    if (!code || code.trim() === '') {
      throw new CadError('invalid', `${comp.ref}: no firmware sketch`, `add [code ${comp.ref}]`);
    }
    firmware[comp.ref] = await getCompiledHex(code);
  }

  const shownProbes = list(a.args.probes);
  const allProbes = uniqueProbes(shownProbes, expects);
  const trace = runMixed(q, {
    until,
    ...(stimulus.length ? { stimulus } : {}),
    probes: allProbes,
    firmware,
  });

  const tableProbes = shownProbes.length ? shownProbes : allProbes;
  const parts = [formatMixed(trace, tableProbes, q)];
  for (const ref of Object.keys(trace.serial).sort(naturalCompare)) {
    const raw = trace.serial[ref]!.trimEnd();
    if (!raw) continue;
    const single = raw.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
    const text = single.length > 512 ? `${single.slice(0, 512)}…` : single;
    parts.push(`serial ${ref}: ${text}`);
  }
  if (trace.warnings.length) parts.push(`warn: ${trace.warnings.join(' · ')}`);

  const checks = expects.map(e => {
    if (e.kind === 'table') return `FAIL line ${e.line}: expect table needs a logic analysis`;
    const s = extractMixedSeries(q, trace, e.probe, until);
    return checkNumber(e, evalMeasure(s, e.measure, e.at), s.invalid);
  });

  return { text: parts.join('\n'), checks };
}

/** Run one analysis plus its expects. */
export async function runAnalysis(q: Query, a: TestAnalysis | undefined, expects: TestExpect[]): Promise<Outcome> {
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
    case 'tran':
      return runTran(q, a, expects);
    case 'ac':
      return runAc(q, a, expects);
    case 'run':
      return runMixedAnalysis(q, a, expects);
    default:
      throw new CadError('invalid', `${a.kind} analysis is not available yet`, 'use dc (or op), logic, tran, ac, or run');
  }
}

const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Run the file's [tests]. One line per test; failures carry the failing checks. */
export async function runFileTests(q: Query, testsText: string | undefined, pattern = '*'): Promise<{ text: string; passed: number; failed: number }> {
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
      const out = await runAnalysis(q, t.analysis, t.expects);
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
export async function runAdhoc(q: Query, run: string): Promise<string> {
  const [t] = parseTests(run, 'sim');
  const out = await runAnalysis(q, t!.analysis, t!.expects);
  return [out.text, ...out.checks].join('\n');
}
