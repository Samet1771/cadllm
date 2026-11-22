// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, naturalCompare } from '@cadllm/core';
import { solveLinear } from './linear.ts';
import {
  DEFAULT_ABSTOL,
  DEFAULT_GMIN,
  DEFAULT_RELTOL,
  DEFAULT_TEMP_K,
  DEFAULT_VNTOL,
  ZENER_BASE,
  thermalVoltage,
  type NetlistElement,
  type NetlistInput,
  type NetlistResult,
  type SolveOptions,
} from './types.ts';

const EXP_LIMIT = 80;

interface LinearR {
  aIdx: number;
  bIdx: number;
  g: number;
  ref: string;
}

interface BranchV {
  posIdx: number;
  negIdx: number;
  voltage: number;
  branchIdx: number;
  ref: string;
}

interface SourceI {
  fromIdx: number;
  toIdx: number;
  current: number;
}

interface NonlinearDev {
  ref: string;
  aIdx: number;
  kIdx: number;
  is: number;
  n: number;
  vz?: number;
  ibv: number;
  nbv: number;
}

function expLim(x: number): { val: number; deriv: number } {
  if (x <= EXP_LIMIT) {
    const e = Math.exp(x);
    return { val: e, deriv: e };
  }
  const eMax = Math.exp(EXP_LIMIT);
  return { val: eMax * (1 + (x - EXP_LIMIT)), deriv: eMax };
}

function evalNonlinear(dev: NonlinearDev, vd: number, vt: number): { i: number; g: number } {
  const vteF = dev.n * vt;
  const { val: ef, deriv: df } = expLim(vd / vteF);
  let i = dev.is * (ef - 1);
  let g = (dev.is / vteF) * df;

  if (dev.vz !== undefined) {
    const vteR = dev.nbv * vt;
    const { val: er, deriv: dr } = expLim(-(vd + dev.vz) / vteR);
    const e0 = Math.exp(-dev.vz / vteR);
    i -= dev.ibv * (er - e0);
    g += (dev.ibv / vteR) * dr;
  }
  return { i, g };
}

function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): { v: number; limited: boolean } {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      if (arg > 0) return { v: vold + vt * Math.log(arg), limited: true };
      return { v: vcrit, limited: true };
    }
    return { v: vt * Math.log(vnew / vt), limited: true };
  }
  return { v: vnew, limited: false };
}

function limitDevice(dev: NonlinearDev, vnew: number, vold: number, vt: number): { v: number; limited: boolean } {
  const vteF = dev.n * vt;
  const vcritF = Math.max(2 * vteF, vteF * Math.log(vteF / (Math.SQRT2 * dev.is)));
  const fLim = pnjlim(vnew, vold, vteF, vcritF);
  if (fLim.limited) return fLim;

  if (dev.vz !== undefined) {
    const vteR = dev.nbv * vt;
    const vcritR = Math.max(2 * vteR, vteR * Math.log(vteR / (Math.SQRT2 * dev.ibv)));
    const rLim = pnjlim(-(vnew + dev.vz), -(vold + dev.vz), vteR, vcritR);
    if (rLim.limited) return { v: -(rLim.v + dev.vz), limited: true };
  }
  return { v: vnew, limited: false };
}

function checkLoops(
  branches: Array<{ ref: string; u: number; v: number }>,
  nodeLabel: (id: number) => string,
): void {
  const parent = new Map<number, number>();
  const treeAdj = new Map<number, Array<{ to: number; ref: string }>>();

  const find = (x: number): number => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const nxt = parent.get(cur)!;
      parent.set(cur, root);
      cur = nxt;
    }
    return root;
  };

  const findPath = (src: number, dst: number): string[] => {
    const visited = new Set<number>([src]);
    const prev = new Map<number, { from: number; ref: string }>();
    const queue = [src];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      if (cur === dst) break;
      for (const edge of treeAdj.get(cur) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        prev.set(edge.to, { from: cur, ref: edge.ref });
        queue.push(edge.to);
      }
    }
    const refs: string[] = [];
    let cur = dst;
    while (cur !== src) {
      const step = prev.get(cur)!;
      refs.push(step.ref);
      cur = step.from;
    }
    return refs;
  };

  for (const br of branches) {
    if (br.u === br.v) {
      throw new CadError('invalid', `voltage source/inductor loop: ${br.ref} shorts ${nodeLabel(br.u)} to itself`);
    }
    const ru = find(br.u);
    const rv = find(br.v);
    if (ru === rv) {
      const cycle = [...findPath(br.u, br.v), br.ref].sort(naturalCompare);
      throw new CadError('invalid', `voltage source/inductor loop involving ${cycle.join(', ')}`);
    }
    parent.set(ru, rv);
    if (!treeAdj.has(br.u)) treeAdj.set(br.u, []);
    if (!treeAdj.has(br.v)) treeAdj.set(br.v, []);
    treeAdj.get(br.u)!.push({ to: br.v, ref: br.ref });
    treeAdj.get(br.v)!.push({ to: br.u, ref: br.ref });
  }
}

function checkFloating(
  nodes: number[],
  refNode: number,
  allEdges: Array<[number, number]>,
  linearEdges: Array<[number, number]>,
  activeNodes: Set<number>,
  nodeLabel: (id: number) => string,
  undrivenDrivers?: Record<number, string[]>,
): void {
  const adj = new Map<number, number[]>();
  const nonRefAdj = new Map<number, number[]>();
  for (const [u, v] of allEdges) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u)!.push(v);
    adj.get(v)!.push(u);
    if (u !== refNode && v !== refNode) {
      if (!nonRefAdj.has(u)) nonRefAdj.set(u, []);
      if (!nonRefAdj.has(v)) nonRefAdj.set(v, []);
      nonRefAdj.get(u)!.push(v);
      nonRefAdj.get(v)!.push(u);
    }
  }

  // 1. Nodes unreachable from refNode via any DC element (R, V, L, D, DZ)
  const visited = new Set<number>([refNode]);
  const queue = [refNode];
  for (let head = 0; head < queue.length; head++) {
    for (const nxt of adj.get(queue[head]!) ?? []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }

  // 2. Non-reference nodes linearly tied to refNode via R, V, or L
  const linearToRef = new Set<number>();
  for (const [u, v] of linearEdges) {
    if (u === refNode && v !== refNode) linearToRef.add(v);
    if (v === refNode && u !== refNode) linearToRef.add(u);
  }

  // 3. Connected components of G \ {refNode}: a component attached only via unexcited
  //    diodes (no linear R/V/L edge to reference and no active current source) is floating.
  const floatingSet = new Set<number>();
  const seenComp = new Set<number>();
  for (const start of nodes) {
    if (!visited.has(start)) {
      floatingSet.add(start);
      continue;
    }
    if (seenComp.has(start)) continue;
    const comp: number[] = [start];
    seenComp.add(start);
    let groundedOrActive = linearToRef.has(start) || activeNodes.has(start);
    for (let head = 0; head < comp.length; head++) {
      const cur = comp[head]!;
      for (const nxt of nonRefAdj.get(cur) ?? []) {
        if (!seenComp.has(nxt)) {
          seenComp.add(nxt);
          comp.push(nxt);
          if (linearToRef.has(nxt) || activeNodes.has(nxt)) groundedOrActive = true;
        }
      }
    }
    if (!groundedOrActive) {
      for (const id of comp) floatingSet.add(id);
    }
  }

  if (floatingSet.size > 0) {
    const floating = [...floatingSet];
    const names = floating.map(nodeLabel).sort(naturalCompare);
    const driverSet = new Set<string>();
    for (const id of floating) {
      for (const drv of undrivenDrivers?.[id] ?? []) driverSet.add(drv);
    }
    const hint = driverSet.size > 0
      ? `driven only by ${[...driverSet].sort(naturalCompare).join(', ')}: pass logic levels`
      : undefined;
    throw new CadError(
      'invalid',
      `floating net${names.length > 1 ? 's' : ''} ${names.join(', ')}: no DC path to reference ${nodeLabel(refNode)}`,
      hint,
    );
  }
}

const valAt = (x: Float64Array, idx: number): number => (idx < 0 ? 0 : x[idx]!);

const stampConductance = (a: Float64Array, dim: number, i: number, j: number, g: number): void => {
  if (i >= 0) a[i * dim + i] = a[i * dim + i]! + g;
  if (j >= 0) a[j * dim + j] = a[j * dim + j]! + g;
  if (i >= 0 && j >= 0) {
    a[i * dim + j] = a[i * dim + j]! - g;
    a[j * dim + i] = a[j * dim + i]! - g;
  }
};

/**
 * Solve a numeric-node MNA netlist for its DC operating point.
 * Node `reference` (default 0) is fixed at 0 V.
 */
export function solveNetlist(input: NetlistInput, opts: SolveOptions = {}): NetlistResult {
  const refNode = input.reference ?? 0;
  const tempK = opts.temp ?? DEFAULT_TEMP_K;
  if (!Number.isFinite(tempK) || tempK <= 0) {
    throw new CadError('invalid', `invalid temperature ${tempK} K; must be > 0`);
  }
  if (opts.maxIter !== undefined && (!Number.isInteger(opts.maxIter) || opts.maxIter < 1)) {
    throw new CadError('invalid', `invalid maxIter ${opts.maxIter}; must be a positive integer`);
  }
  const vt = thermalVoltage(tempK);
  const warnings: string[] = [];
  const nodeLabel = (id: number): string => input.nodeNames?.[id] ?? `node ${id}`;

  // Expand any diode with series resistance rs > 0 into an internal junction node
  const rawNodes = new Set<number>();
  let maxNode = refNode;
  const addNode = (id: number) => {
    if (id > maxNode) maxNode = id;
    if (id !== refNode) rawNodes.add(id);
  };
  for (const el of input.elements) {
    if (el.kind === 'R' || el.kind === 'C' || el.kind === 'L') {
      addNode(el.a);
      addNode(el.b);
    } else if (el.kind === 'V') {
      addNode(el.pos);
      addNode(el.neg);
    } else if (el.kind === 'I') {
      addNode(el.from);
      addNode(el.to);
    } else {
      addNode(el.anode);
      addNode(el.cathode);
    }
  }

  const resistors: LinearR[] = [];
  const voltageBranches: BranchV[] = [];
  const currentSources: SourceI[] = [];
  const nonlinear: NonlinearDev[] = [];
  const loopEdges: Array<{ ref: string; u: number; v: number }> = [];
  const dcEdges: Array<[number, number]> = [];
  const linearEdges: Array<[number, number]> = [];
  const activeNodes = new Set<number>();
  const elementInspectors: Array<{ kind: NetlistElement['kind']; ref: string; idx: number; a: number; b: number; val: number }> = [];

  const expandedNames = { ...(input.nodeNames ?? {}) };
  let synthNode = maxNode + 1;
  const idxMap = new Map<number, number>();
  const sortedRealNodes = [...rawNodes].sort((a, b) => a - b);

  // Pre-register real nodes; internal rs nodes (if any) come right after.
  const allNodes = [...sortedRealNodes];
  const nodeIdx = (id: number): number => (id === refNode ? -1 : idxMap.get(id)!);

  const pendingElements: NetlistElement[] = [];
  for (const el of input.elements) {
    if (el.kind === 'R') {
      if (!Number.isFinite(el.resistance) || el.resistance <= 0) {
        throw new CadError('invalid', `${el.ref}: resistance must be > 0 (got ${el.resistance})`);
      }
      pendingElements.push(el);
    } else if (el.kind === 'V') {
      if (!Number.isFinite(el.voltage)) throw new CadError('invalid', `${el.ref}: invalid voltage ${el.voltage}`);
      pendingElements.push(el);
    } else if (el.kind === 'I') {
      if (!Number.isFinite(el.current)) throw new CadError('invalid', `${el.ref}: invalid current ${el.current}`);
      pendingElements.push(el);
    } else if (el.kind === 'D' || el.kind === 'DZ') {
      const m = el.kind === 'DZ' ? (el.model ?? ZENER_BASE) : el.model;
      if (!Number.isFinite(m.is) || m.is <= 0 || !Number.isFinite(m.n) || m.n <= 0) {
        throw new CadError('invalid', `${el.ref}: invalid diode model parameters`);
      }
      if (el.kind === 'DZ' && (!Number.isFinite(el.vz) || el.vz <= 0)) {
        throw new CadError('invalid', `${el.ref}: zener breakdown voltage must be > 0 (got ${el.vz})`);
      }
      if (m.rs !== undefined && m.rs > 0) {
        const jId = synthNode++;
        expandedNames[jId] = `${el.ref}.int`;
        allNodes.push(jId);
      }
      pendingElements.push(el);
    } else {
      pendingElements.push(el);
    }
  }

  for (let k = 0; k < allNodes.length; k++) idxMap.set(allNodes[k]!, k);
  const labelOf = (id: number): string => expandedNames[id] ?? nodeLabel(id);

  let nextSynth = maxNode + 1;
  for (const el of pendingElements) {
    if (el.kind === 'R') {
      resistors.push({ aIdx: nodeIdx(el.a), bIdx: nodeIdx(el.b), g: 1 / el.resistance, ref: el.ref });
      dcEdges.push([el.a, el.b]);
      linearEdges.push([el.a, el.b]);
      elementInspectors.push({ kind: 'R', ref: el.ref, idx: resistors.length - 1, a: el.a, b: el.b, val: el.resistance });
    } else if (el.kind === 'C') {
      elementInspectors.push({ kind: 'C', ref: el.ref, idx: -1, a: el.a, b: el.b, val: 0 });
    } else if (el.kind === 'L') {
      const branchIdx = voltageBranches.length;
      voltageBranches.push({ posIdx: nodeIdx(el.a), negIdx: nodeIdx(el.b), voltage: 0, branchIdx, ref: el.ref });
      loopEdges.push({ ref: el.ref, u: el.a, v: el.b });
      dcEdges.push([el.a, el.b]);
      linearEdges.push([el.a, el.b]);
      elementInspectors.push({ kind: 'L', ref: el.ref, idx: branchIdx, a: el.a, b: el.b, val: 0 });
    } else if (el.kind === 'V') {
      const branchIdx = voltageBranches.length;
      voltageBranches.push({ posIdx: nodeIdx(el.pos), negIdx: nodeIdx(el.neg), voltage: el.voltage, branchIdx, ref: el.ref });
      loopEdges.push({ ref: el.ref, u: el.pos, v: el.neg });
      dcEdges.push([el.pos, el.neg]);
      linearEdges.push([el.pos, el.neg]);
      elementInspectors.push({ kind: 'V', ref: el.ref, idx: branchIdx, a: el.pos, b: el.neg, val: el.voltage });
    } else if (el.kind === 'I') {
      currentSources.push({ fromIdx: nodeIdx(el.from), toIdx: nodeIdx(el.to), current: el.current });
      if (el.from !== refNode) activeNodes.add(el.from);
      if (el.to !== refNode) activeNodes.add(el.to);
      elementInspectors.push({ kind: 'I', ref: el.ref, idx: currentSources.length - 1, a: el.from, b: el.to, val: el.current });
    } else {
      const m = el.kind === 'DZ' ? (el.model ?? ZENER_BASE) : el.model;
      let anodeId = el.anode;
      if (m.rs !== undefined && m.rs > 0) {
        const jId = nextSynth++;
        resistors.push({ aIdx: nodeIdx(el.anode), bIdx: nodeIdx(jId), g: 1 / m.rs, ref: `${el.ref}.rs` });
        dcEdges.push([el.anode, jId]);
        linearEdges.push([el.anode, jId]);
        anodeId = jId;
      }
      const dIdx = nonlinear.length;
      nonlinear.push({
        ref: el.ref,
        aIdx: nodeIdx(anodeId),
        kIdx: nodeIdx(el.cathode),
        is: m.is,
        n: m.n,
        ...(el.kind === 'DZ' ? { vz: el.vz } : {}),
        ibv: el.kind === 'DZ' ? (el.model ?? ZENER_BASE).ibv : 0,
        nbv: el.kind === 'DZ' ? (el.model ?? ZENER_BASE).nbv : 1,
      });
      dcEdges.push([anodeId, el.cathode]);
      elementInspectors.push({ kind: el.kind, ref: el.ref, idx: dIdx, a: anodeId, b: el.cathode, val: 0 });
    }
  }

  // Topology checks BEFORE solving
  checkLoops(loopEdges, labelOf);
  checkFloating(allNodes, refNode, dcEdges, linearEdges, activeNodes, labelOf, input.undrivenDrivers);

  const numNodes = allNodes.length;
  const numBranches = voltageBranches.length;
  const dim = numNodes + numBranches;

  const colLabels = [
    ...allNodes.map(id => `net ${labelOf(id)}`),
    ...voltageBranches.map(br => `branch ${br.ref}`),
  ];
  const rowLabels = [
    ...allNodes.map(id => `net ${labelOf(id)}`),
    ...voltageBranches.map(br => `branch ${br.ref}`),
  ];

  const runNR = (
    xInit: Float64Array<ArrayBuffer>,
    vdInit: Float64Array<ArrayBuffer>,
    gminVal: number,
    sourceScale: number,
    budget: number,
  ): { converged: boolean; iterations: number; x: Float64Array<ArrayBuffer>; vd: Float64Array<ArrayBuffer> } => {
    let xPrev: Float64Array<ArrayBuffer> = new Float64Array(xInit);
    let vdPrev: Float64Array<ArrayBuffer> = new Float64Array(vdInit);
    const mat = new Float64Array(dim * dim);
    const rhs = new Float64Array(dim);
    const iUsed = new Float64Array(nonlinear.length);
    const gUsed = new Float64Array(nonlinear.length);

    for (let iter = 1; iter <= budget; iter++) {
      mat.fill(0);
      rhs.fill(0);

      if (gminVal > 0) {
        for (let i = 0; i < numNodes; i++) mat[i * dim + i] = mat[i * dim + i]! + gminVal;
      }
      for (const r of resistors) {
        stampConductance(mat, dim, r.aIdx, r.bIdx, r.g);
      }
      for (const cs of currentSources) {
        const val = cs.current * sourceScale;
        if (cs.fromIdx >= 0) rhs[cs.fromIdx] = rhs[cs.fromIdx]! - val;
        if (cs.toIdx >= 0) rhs[cs.toIdx] = rhs[cs.toIdx]! + val;
      }
      for (const br of voltageBranches) {
        const row = numNodes + br.branchIdx;
        if (br.posIdx >= 0) {
          mat[br.posIdx * dim + row] = mat[br.posIdx * dim + row]! + 1;
          mat[row * dim + br.posIdx] = mat[row * dim + br.posIdx]! + 1;
        }
        if (br.negIdx >= 0) {
          mat[br.negIdx * dim + row] = mat[br.negIdx * dim + row]! - 1;
          mat[row * dim + br.negIdx] = mat[row * dim + br.negIdx]! - 1;
        }
        rhs[row] = br.voltage * sourceScale;
      }

      for (let j = 0; j < nonlinear.length; j++) {
        const dev = nonlinear[j]!;
        const { i, g } = evalNonlinear(dev, vdPrev[j]!, vt);
        iUsed[j] = i;
        gUsed[j] = g;
        const ieq = i - g * vdPrev[j]!;
        stampConductance(mat, dim, dev.aIdx, dev.kIdx, g);
        if (dev.aIdx >= 0) rhs[dev.aIdx] = rhs[dev.aIdx]! - ieq;
        if (dev.kIdx >= 0) rhs[dev.kIdx] = rhs[dev.kIdx]! + ieq;
      }

      const xNext = solveLinear(mat, rhs, dim, colLabels, rowLabels);
      if (nonlinear.length === 0) {
        return { converged: true, iterations: iter, x: xNext, vd: vdPrev };
      }

      let tolOk = true;
      for (let i = 0; i < numNodes; i++) {
        const dv = Math.abs(xNext[i]! - xPrev[i]!);
        const tol = DEFAULT_VNTOL + DEFAULT_RELTOL * Math.max(Math.abs(xNext[i]!), Math.abs(xPrev[i]!));
        if (dv > tol) { tolOk = false; break; }
      }
      if (tolOk) {
        for (let i = numNodes; i < dim; i++) {
          const di = Math.abs(xNext[i]! - xPrev[i]!);
          const tol = DEFAULT_ABSTOL + DEFAULT_RELTOL * Math.max(Math.abs(xNext[i]!), Math.abs(xPrev[i]!));
          if (di > tol) { tolOk = false; break; }
        }
      }

      let anyLimited = false;
      const vdNext = new Float64Array(nonlinear.length);
      for (let j = 0; j < nonlinear.length; j++) {
        const dev = nonlinear[j]!;
        const vdCand = valAt(xNext, dev.aIdx) - valAt(xNext, dev.kIdx);
        const { v: vdLim, limited } = limitDevice(dev, vdCand, vdPrev[j]!, vt);
        if (limited) anyLimited = true;
        vdNext[j] = vdLim;

        if (tolOk) {
          const iHat = iUsed[j]! + gUsed[j]! * (vdCand - vdPrev[j]!);
          const iTrue = evalNonlinear(dev, vdCand, vt).i;
          const ctol = DEFAULT_ABSTOL + DEFAULT_RELTOL * Math.max(Math.abs(iTrue), Math.abs(iHat));
          if (Math.abs(iTrue - iHat) > ctol) tolOk = false;
        }
      }

      if (!anyLimited && tolOk) {
        const vdSolved = new Float64Array(nonlinear.length);
        for (let j = 0; j < nonlinear.length; j++) {
          const dev = nonlinear[j]!;
          vdSolved[j] = valAt(xNext, dev.aIdx) - valAt(xNext, dev.kIdx);
        }
        return { converged: true, iterations: iter, x: xNext, vd: vdSolved };
      }
      xPrev = xNext;
      vdPrev = vdNext;
    }

    return { converged: false, iterations: budget, x: xPrev, vd: vdPrev };
  };

  const hasNonlinear = nonlinear.length > 0;
  const baseGmin = opts.gmin ?? (hasNonlinear ? DEFAULT_GMIN : 0);
  const explicitBudget = opts.maxIter;
  const totalBudget = explicitBudget ?? 500;
  const plainBudget = explicitBudget !== undefined
    ? (explicitBudget <= 25 ? explicitBudget : Math.min(explicitBudget, 100))
    : 100;

  let totalIters = 0;
  const zerosX = new Float64Array(dim);
  const zerosVd = new Float64Array(nonlinear.length);

  // Stage 1: Direct NR
  let sol = runNR(zerosX, zerosVd, baseGmin, 1.0, Math.min(plainBudget, totalBudget));
  totalIters += sol.iterations;

  // Stage 2: Gmin stepping
  if (!sol.converged && totalIters < totalBudget) {
    const targetGmin = baseGmin > 0 ? baseGmin : DEFAULT_GMIN;
    const targetExp = Math.log10(targetGmin);
    let exp = -2;
    let stepExp = 1;
    let xStep = new Float64Array(dim);
    let vdStep = new Float64Array(nonlinear.length);
    let gminOk = true;

    while (totalIters < totalBudget) {
      const curExp = Math.max(targetExp, exp);
      const g = Math.pow(10, curExp);
      const stepRes = runNR(xStep, vdStep, g, 1.0, Math.min(30, totalBudget - totalIters));
      totalIters += stepRes.iterations;
      if (stepRes.converged) {
        xStep = new Float64Array(stepRes.x);
        vdStep = new Float64Array(stepRes.vd);
        if (curExp <= targetExp + 1e-9) {
          sol = { ...stepRes, converged: true };
          break;
        }
        exp = curExp - stepExp;
      } else {
        stepExp *= 0.5;
        if (stepExp < 0.125) {
          gminOk = false;
          break;
        }
        exp = curExp + stepExp;
      }
    }
    if (!gminOk || !sol.converged) {
      // Keep last best iterate if source stepping doesn't run or fails
      sol = { ...sol, converged: false };
    }
  }

  // Stage 3: Source stepping
  if (!sol.converged && totalIters < totalBudget) {
    const targetGmin = baseGmin > 0 ? baseGmin : DEFAULT_GMIN;
    let alpha = 0;
    let dAlpha = 0.1;
    let xStep = new Float64Array(dim);
    let vdStep = new Float64Array(nonlinear.length);

    while (alpha < 1 && totalIters < totalBudget) {
      const nextAlpha = Math.min(1, alpha + dAlpha);
      const stepRes = runNR(xStep, vdStep, targetGmin, nextAlpha, Math.min(30, totalBudget - totalIters));
      totalIters += stepRes.iterations;
      if (stepRes.converged) {
        alpha = nextAlpha;
        xStep = new Float64Array(stepRes.x);
        vdStep = new Float64Array(stepRes.vd);
        if (alpha >= 1 - 1e-12) {
          sol = { ...stepRes, converged: true };
          break;
        }
        dAlpha = Math.min(0.25, dAlpha * 1.5);
      } else {
        dAlpha *= 0.5;
        if (dAlpha < 1e-4) break;
      }
    }
  }

  let reason: string | undefined;
  if (!sol.converged) {
    reason = `Newton-Raphson failed to converge within ${totalIters} iterations`;
    warnings.push(reason);
  }

  const vOut: Record<number, number> = { [refNode]: 0 };
  for (const id of sortedRealNodes) {
    vOut[id] = sol.x[idxMap.get(id)!]!;
  }

  const iOut: Record<string, number> = {};
  for (const insp of elementInspectors) {
    if (insp.kind === 'R') {
      const va = vOut[insp.a] ?? valAt(sol.x, idxMap.get(insp.a) ?? -1);
      const vb = vOut[insp.b] ?? valAt(sol.x, idxMap.get(insp.b) ?? -1);
      iOut[insp.ref] = (va - vb) / insp.val;
    } else if (insp.kind === 'C') {
      iOut[insp.ref] = 0;
    } else if (insp.kind === 'L') {
      iOut[insp.ref] = sol.x[numNodes + insp.idx]!;
    } else if (insp.kind === 'V') {
      // MNA branch unknown is current entering '+' and leaving '-'; negate for current delivered out of '+'
      iOut[insp.ref] = -sol.x[numNodes + insp.idx]!;
    } else if (insp.kind === 'I') {
      iOut[insp.ref] = insp.val;
    } else {
      const dev = nonlinear[insp.idx]!;
      const vd = valAt(sol.x, dev.aIdx) - valAt(sol.x, dev.kIdx);
      iOut[insp.ref] = evalNonlinear(dev, vd, vt).i;
    }
  }

  return {
    v: vOut,
    i: iOut,
    converged: sol.converged,
    iterations: totalIters,
    warnings,
    ...(reason !== undefined ? { reason } : {}),
  };
}
