// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, naturalCompare } from '@cadllm/core';
import { Simulation, type ResultType } from 'eecircuit-engine';
import { formatAnalysisCard } from './netlist.ts';
import type { SpiceAnalysis, SpiceResult } from './types.ts';

let simPromise: Promise<Simulation> | undefined;
let runQueue: Promise<void> = Promise.resolve();

const FATAL_RE =
  /Simulation interrupted due to error|Error: circuit not parsed|Error on line|Unable to find definition of model|unknown subckt|could not find a valid modelname|run simulation\(s\) aborted|run simulation not started|operating point could not be simulated|Error during 'write'|Timestep too small|Warning: No job .* defined/i;

function getSim(): Promise<Simulation> {
  if (!simPromise) {
    simPromise = (async () => {
      const s = new Simulation();
      await s.start();
      return s;
    })();
  }
  return simPromise;
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = runQueue.then(fn, fn);
  runQueue = next.then(() => undefined, () => undefined);
  return next;
}

function validateAnalysis(a: SpiceAnalysis): void {
  if (a.kind === 'tran') {
    if (!Number.isFinite(a.stop) || a.stop <= 0) {
      throw new CadError('invalid', `tran stop time must be > 0 (got ${a.stop})`);
    }
    if (a.step !== undefined && (!Number.isFinite(a.step) || a.step <= 0)) {
      throw new CadError('invalid', `tran step must be > 0 (got ${a.step})`);
    }
    if (a.start !== undefined && (!Number.isFinite(a.start) || a.start < 0 || a.start >= a.stop)) {
      throw new CadError('invalid', `tran start must be in [0, stop) (got ${a.start})`);
    }
  } else if (a.kind === 'ac') {
    if (a.sweep !== 'dec' && a.sweep !== 'oct' && a.sweep !== 'lin') {
      throw new CadError('invalid', `unsupported AC sweep "${String(a.sweep)}"`, 'use dec, oct, or lin');
    }
    if (!Number.isInteger(a.points) || a.points < 1) {
      throw new CadError('invalid', `AC points must be a positive integer (got ${a.points})`);
    }
    if (!Number.isFinite(a.start) || a.start <= 0 || !Number.isFinite(a.stop) || a.stop < a.start) {
      throw new CadError('invalid', `AC frequency range must satisfy 0 < start <= stop (got ${a.start}..${a.stop})`);
    }
  }
}

function prepareNetlist(netlist: string, analysis: SpiceAnalysis): string {
  const rawLines = netlist.replace(/\r\n?/g, '\n').split('\n');
  const activeLines = rawLines.slice(1).filter(l => !/^\s*[*;]/.test(l));
  const hasAnalysis = activeLines.some(l => /^\s*\.(op|tran|ac|dc)\b/i.test(l));
  const endIdx = rawLines.findIndex((l, i) => i > 0 && /^\s*\.end\b/i.test(l));
  const out = [...rawLines];
  if (!hasAnalysis) {
    const card = formatAnalysisCard(analysis);
    if (endIdx >= 0) out.splice(endIdx, 0, card);
    else out.push(card);
  }
  if (!out.some((l, i) => i > 0 && /^\s*\.end\b/i.test(l))) {
    out.push('.end');
  }
  return out.join('\n');
}

function normalizeLog(info: string, errors: string[]): string[] {
  const seen: string[] = [];
  for (const rawLine of [...info.split(/\r?\n/), ...errors]) {
    const line = rawLine.replace(/^(?:ngspice\s+\d+\s+->\s*)+/g, '').trim();
    if (!line || line === 'binary raw file "out.raw"' || /^Date:\s/i.test(line)) continue;
    seen.push(line);
  }
  return seen;
}

function toResult(raw: ResultType, analysis: SpiceAnalysis, log: string[]): SpiceResult {
  const scaleName: 'time' | 'frequency' = analysis.kind === 'ac' ? 'frequency' : 'time';

  if (raw.dataType === 'complex') {
    const sorted = [...raw.data].sort((a, b) => naturalCompare(a.name, b.name));
    const freqEntry = raw.data.find(d => d.name.toLowerCase() === 'frequency');
    const scaleValues = Float64Array.from(freqEntry?.values ?? [], c => c.real);
    const vectors: Record<string, Float64Array> = {};
    const complex: Record<string, { re: Float64Array; im: Float64Array }> = {};
    for (const d of sorted) {
      if (d.name.toLowerCase() === 'frequency') continue;
      const re = Float64Array.from(d.values, c => c.real);
      const im = Float64Array.from(d.values, c => c.img);
      complex[d.name] = { re, im };
      vectors[d.name] = Float64Array.from(d.values, c => Math.hypot(c.real, c.img));
    }
    return { vectors, scale: { name: scaleName, values: scaleValues }, complex, log };
  }

  const sorted = [...raw.data].sort((a, b) => naturalCompare(a.name, b.name));
  const timeEntry = raw.data.find(d => d.name.toLowerCase() === 'time');
  const scaleValues = timeEntry
    ? Float64Array.from(timeEntry.values)
    : new Float64Array(raw.numPoints > 0 ? raw.numPoints : 1);
  const vectors: Record<string, Float64Array> = {};
  for (const d of sorted) {
    if (d.name.toLowerCase() === 'time') continue;
    vectors[d.name] = Float64Array.from(d.values);
  }
  return { vectors, scale: { name: scaleName, values: scaleValues }, log };
}

/** Run an arbitrary SPICE netlist through the shared headless ngspice WASM instance. */
export async function runSpice(netlist: string, analysis: SpiceAnalysis): Promise<SpiceResult> {
  if (!netlist.trim()) {
    throw new CadError('invalid', 'SPICE netlist is empty');
  }
  validateAnalysis(analysis);
  const prepared = prepareNetlist(netlist, analysis);

  return serialize(async () => {
    const sim = await getSim();
    sim.setNetList(prepared);
    const raw = await sim.runSim();
    const info = sim.getInfo();
    const errs = sim.getError();
    const log = normalizeLog(info, errs);

    const errText = [...errs, info].join('\n');
    const empty = !Array.isArray(raw.variableNames) || raw.variableNames.length === 0 || raw.numPoints === 0;
    if (FATAL_RE.test(errText) || empty) {
      const detail =
        errs.map(s => s.trim()).filter(Boolean).slice(0, 4).join(' · ') ||
        'ngspice failed to produce simulation vectors';
      throw new CadError('invalid', `ngspice error: ${detail}`);
    }

    return toResult(raw, analysis, log);
  });
}
