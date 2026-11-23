// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Query } from '@cadllm/core';
import { buildSpiceCircuit, toSpiceNetlist, type BuiltSpiceCircuit } from './netlist.ts';
import { runSpice } from './runner.ts';
import type { AcOptions, OpSpiceOptions, SpiceAnalysis, SpiceResult, TranOptions } from './types.ts';

export * from './types.ts';
export { toSpiceNetlist, runSpice };

function negateComplex(c: { re: Float64Array; im: Float64Array }): { re: Float64Array; im: Float64Array } {
  return { re: c.re.map(x => -x), im: c.im.map(x => -x) };
}

function mapVectors(raw: SpiceResult, built: BuiltSpiceCircuit): SpiceResult {
  const nPts = raw.scale.values.length;
  const rawVecs: Record<string, Float64Array> = {};
  const rawCpx: Record<string, { re: Float64Array; im: Float64Array }> = {};

  const setEntry = (key: string, vec: Float64Array, cpx?: { re: Float64Array; im: Float64Array }) => {
    rawVecs[key] = vec;
    if (cpx) rawCpx[key] = cpx;
  };

  const zeroVec = new Float64Array(nPts);
  const zeroCpx = raw.complex ? { re: new Float64Array(nPts), im: new Float64Array(nPts) } : undefined;
  setEntry(`V(${built.refNetName})`, zeroVec, zeroCpx);

  for (const [k, vec] of Object.entries(raw.vectors)) {
    const lk = k.toLowerCase();
    const cpx = raw.complex?.[k];
    if (lk.startsWith('v(') && lk.endsWith(')')) {
      const nodeLower = lk.slice(2, -1);
      const cadNet = built.nodeMap.get(nodeLower);
      if (cadNet) setEntry(`V(${cadNet})`, vec, cpx);
    } else if (lk.startsWith('i(') && lk.endsWith(')')) {
      const devLower = lk.slice(2, -1);
      const sourceRef = built.sourceMap.get(devLower);
      if (sourceRef) {
        setEntry(`I(${sourceRef})`, vec.map(x => -x), cpx ? negateComplex(cpx) : undefined);
      }
      const senseProbes = built.senseMap.get(devLower);
      if (senseProbes) {
        for (const sp of senseProbes) setEntry(sp, vec, cpx);
      }
    }
  }

  for (const { probeKey, netName } of [...built.netProbes, ...built.pinProbes]) {
    const vec = rawVecs[`V(${netName})`];
    if (vec) setEntry(probeKey, vec, rawCpx[`V(${netName})`]);
  }
  for (const probeKey of built.zeroCurrentProbes) {
    setEntry(probeKey, new Float64Array(nPts), raw.complex ? { re: new Float64Array(nPts), im: new Float64Array(nPts) } : undefined);
  }

  const vectors: Record<string, Float64Array> = {};
  for (const k of Object.keys(rawVecs).sort(naturalCompare)) vectors[k] = rawVecs[k]!;

  if (raw.complex) {
    const complex: Record<string, { re: Float64Array; im: Float64Array }> = {};
    for (const k of Object.keys(rawCpx).sort(naturalCompare)) complex[k] = rawCpx[k]!;
    return { vectors, scale: raw.scale, complex, log: raw.log };
  }
  return { vectors, scale: raw.scale, log: raw.log };
}

async function runCircuitAnalysis(
  q: Query,
  analysis: SpiceAnalysis,
  probes?: string[],
  models?: ReadonlyMap<string, string> | Record<string, string>,
): Promise<SpiceResult> {
  const built = buildSpiceCircuit(q, { analysis, ...(probes ? { probes } : {}), ...(models ? { models } : {}) });
  const raw = await runSpice(built.netlist, analysis);
  return mapVectors(raw, built);
}

/** Run DC operating-point analysis via ngspice. */
export function op(q: Query, opts: OpSpiceOptions = {}): Promise<SpiceResult> {
  return runCircuitAnalysis(q, { kind: 'op' }, opts.probes, opts.models);
}

/** Run transient analysis via ngspice. */
export function tran(q: Query, opts: TranOptions): Promise<SpiceResult> {
  const analysis: SpiceAnalysis = {
    kind: 'tran',
    stop: opts.stop,
    ...(opts.step !== undefined ? { step: opts.step } : {}),
    ...(opts.uic !== undefined ? { uic: opts.uic } : {}),
  };
  return runCircuitAnalysis(q, analysis, opts.probes, opts.models);
}

/** Run AC small-signal frequency sweep analysis via ngspice. */
export function ac(q: Query, opts: AcOptions): Promise<SpiceResult> {
  const analysis: SpiceAnalysis = {
    kind: 'ac',
    sweep: opts.sweep,
    points: opts.points,
    start: opts.start,
    stop: opts.stop,
  };
  return runCircuitAnalysis(q, analysis, opts.probes, opts.models);
}
