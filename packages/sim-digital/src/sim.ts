// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, pinKey, parseSI, type Component, type Net, type PartDef, type PinKey, type Query } from '@cadllm/core';
import { findPin, formatTimeSI, normalizeTime, parseSwitchState, resolveDrives, resolveStrong } from './logic.ts';
import { DEFAULT_PROP_DELAY, evalConstDrives, logicModels } from './models.ts';
import type { Drive, Logic, LogicModel, SimulateOptions, StimulusEvent, Trace, TraceChange, TruthTable } from './types.ts';

const MAX_EVENTS_PER_STEP = 1000;
const MAX_TOTAL_EVENTS = 10000;
const MAX_TRANSITION_ROWS = 200;

type SimEvent =
  | { t: number; seq: number; kind: 'drive'; compId: string; pinKey: PinKey; v: Logic; strength: 'strong' | 'weak' }
  | { t: number; seq: number; kind: 'switch'; compId: string; closed: boolean };

class MinHeap<T> {
  private data: T[] = [];
  private cmp: (a: T, b: T) => number;

  constructor(cmp: (a: T, b: T) => number) {
    this.cmp = cmp;
  }

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  push(item: T): void {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(d[i]!, d[p]!) >= 0) break;
      const tmp = d[i]!;
      d[i] = d[p]!;
      d[p] = tmp;
      i = p;
    }
  }

  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0]!;
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      while (true) {
        let best = i;
        const l = 2 * i + 1;
        const r = l + 1;
        if (l < n && this.cmp(d[l]!, d[best]!) < 0) best = l;
        if (r < n && this.cmp(d[r]!, d[best]!) < 0) best = r;
        if (best === i) break;
        const tmp = d[i]!;
        d[i] = d[best]!;
        d[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

interface CompInstance {
  comp: Component;
  part: PartDef;
  model: LogicModel;
  delay: number;
  state: Record<string, unknown>;
}

interface SwitchLink {
  compId: string;
  netA: number | undefined;
  netB: number | undefined;
  closed: boolean;
}

interface PullLink {
  netA: number | undefined;
  netB: number | undefined;
}

function getCompDelay(comp: Component, model: LogicModel): number {
  if (comp.props.delay !== undefined) {
    const d = parseSI(comp.props.delay);
    if (d === undefined || d < 0) {
      throw new CadError('invalid', `${comp.ref}: invalid delay "${comp.props.delay}"`, 'use e.g. 10n, 5ns, 1u');
    }
    return d;
  }
  return model.delay ?? DEFAULT_PROP_DELAY;
}

function resolvePinNetIndex(q: Query, netIndexById: Map<string, number>, compId: string, pinId: string): number | undefined {
  const net = q.netOfPin(pinKey(compId, pinId));
  return net ? netIndexById.get(net.id) : undefined;
}

/** Generate periodic high/low stimulus events for a switch or button. */
export function clockStimulus(ref: string, period: number, cycles: number, start = 0): StimulusEvent[] {
  if (!Number.isFinite(period) || period <= 0) throw new CadError('invalid', `clockStimulus: period must be > 0`);
  if (!Number.isInteger(cycles) || cycles < 0) throw new CadError('invalid', `clockStimulus: cycles must be a non-negative integer`);
  if (!Number.isFinite(start) || start < 0) throw new CadError('invalid', `clockStimulus: start must be >= 0`);

  const events: StimulusEvent[] = [];
  const half = period / 2;
  for (let i = 0; i < cycles; i++) {
    events.push({ t: normalizeTime(start + i * period), ref, state: 'closed' });
    events.push({ t: normalizeTime(start + i * period + half), ref, state: 'open' });
  }
  return events;
}

/** Run event-driven 4-state digital simulation up to `opts.until` seconds. */
export function simulate(q: Query, opts: SimulateOptions): Trace {
  if (!Number.isFinite(opts.until) || opts.until < 0) {
    throw new CadError('invalid', `simulate: until must be >= 0`);
  }

  const nets: Net[] = q.nets();
  const netNames = nets.map(n => n.name);
  const netIndexById = new Map<string, number>();
  for (let i = 0; i < nets.length; i++) netIndexById.set(nets[i]!.id, i);

  const netValues: Logic[] = Array(nets.length).fill('Z');
  const pinDrives = new Map<PinKey, Drive>();
  const lastScheduled = new Map<PinKey, Drive>();
  const pinToNetIdx = new Map<PinKey, number>();
  const netToComps: Set<string>[] = Array.from({ length: nets.length }, () => new Set<string>());

  for (let i = 0; i < nets.length; i++) {
    for (const pk of nets[i]!.pins) pinToNetIdx.set(pk, i);
  }

  const icComps = new Map<string, CompInstance>();
  const switches = new Map<string, SwitchLink>();
  const pulls: PullLink[] = [];

  for (const comp of q.components()) {
    const part = q.part(comp);
    const simRef = part.sim?.find(s => s.kind === 'logic');
    if (!simRef) continue;
    const model = logicModels.get(simRef.ref);
    if (!model) {
      throw new CadError('invalid', `${comp.ref}: unknown logic model "${simRef.ref}"`);
    }

    if (model.role === 'const') {
      for (const { pinId, v } of evalConstDrives(comp, part)) {
        pinDrives.set(pinKey(comp.id, pinId), { v, strength: 'strong' });
      }
      continue;
    }

    if (model.role === 'switch') {
      const p1 = findPin(part, comp.ref, '1');
      const p2 = findPin(part, comp.ref, '2');
      const closed = parseSwitchState(comp.props.state ?? 'open', comp.ref);
      switches.set(comp.id, {
        compId: comp.id,
        netA: resolvePinNetIndex(q, netIndexById, comp.id, p1.id),
        netB: resolvePinNetIndex(q, netIndexById, comp.id, p2.id),
        closed,
      });
      continue;
    }

    if (model.role === 'pull') {
      const p1 = findPin(part, comp.ref, '1');
      const p2 = findPin(part, comp.ref, '2');
      pulls.push({
        netA: resolvePinNetIndex(q, netIndexById, comp.id, p1.id),
        netB: resolvePinNetIndex(q, netIndexById, comp.id, p2.id),
      });
      continue;
    }

    if (model.role === 'probe') continue;

    // Event-driven IC / logic model
    const inst: CompInstance = {
      comp,
      part,
      model,
      delay: getCompDelay(comp, model),
      state: model.init ? model.init(comp, part) : {},
    };
    icComps.set(comp.id, inst);
    for (const pin of part.pins) {
      const nIdx = resolvePinNetIndex(q, netIndexById, comp.id, pin.id);
      if (nIdx !== undefined) netToComps[nIdx]!.add(comp.id);
    }
  }

  let seq = 0;
  const queue = new MinHeap<SimEvent>((a, b) => (a.t - b.t) || (a.seq - b.seq));

  if (opts.stimulus) {
    for (const ev of opts.stimulus) {
      if (!Number.isFinite(ev.t) || ev.t < 0) {
        throw new CadError('invalid', `stimulus: invalid time ${ev.t} for ${ev.ref}`);
      }
      const comp = q.requireComponent(ev.ref);
      const sw = switches.get(comp.id);
      if (!sw) {
        throw new CadError('invalid', `stimulus target ${ev.ref} is not a switch or button`);
      }
      const closed = parseSwitchState(ev.state, ev.ref);
      const t = normalizeTime(ev.t);
      if (t <= opts.until) {
        queue.push({ t, seq: seq++, kind: 'switch', compId: comp.id, closed });
      }
    }
  }

  // Union-find workspace reused during net resolution.
  const parent = new Int32Array(nets.length);
  const findRoot = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let cur = x;
    while (cur !== r) {
      const nxt = parent[cur]!;
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  };

  /** Resolve all supernets and return indices of nets whose value changed. */
  const resolveAllNets = (): number[] => {
    const n = nets.length;
    for (let i = 0; i < n; i++) parent[i] = i;
    for (const sw of switches.values()) {
      if (!sw.closed || sw.netA === undefined || sw.netB === undefined) continue;
      const ra = findRoot(sw.netA);
      const rb = findRoot(sw.netB);
      if (ra !== rb) parent[rb] = ra;
    }

    const groupDrives = new Map<number, Drive[]>();
    for (const [pk, drv] of pinDrives) {
      const idx = pinToNetIdx.get(pk);
      if (idx === undefined) continue;
      const root = findRoot(idx);
      let list = groupDrives.get(root);
      if (!list) {
        list = [];
        groupDrives.set(root, list);
      }
      list.push(drv);
    }

    const strongByRoot = new Map<number, Logic>();
    for (const [root, list] of groupDrives) {
      const sv = resolveStrong(list);
      if (sv !== 'Z') strongByRoot.set(root, sv);
    }

    // Bidirectional 1-hop weak propagation through pull resistors (0/1 strong values only).
    for (const p of pulls) {
      if (p.netA === undefined || p.netB === undefined) continue;
      const ra = findRoot(p.netA);
      const rb = findRoot(p.netB);
      if (ra === rb) continue;
      const sa = strongByRoot.get(ra);
      const sb = strongByRoot.get(rb);
      if (sa === '0' || sa === '1') {
        let listB = groupDrives.get(rb);
        if (!listB) { listB = []; groupDrives.set(rb, listB); }
        listB.push({ v: sa, strength: 'weak' });
      }
      if (sb === '0' || sb === '1') {
        let listA = groupDrives.get(ra);
        if (!listA) { listA = []; groupDrives.set(ra, listA); }
        listA.push({ v: sb, strength: 'weak' });
      }
    }

    const resolvedByRoot = new Map<number, Logic>();
    for (const [root, list] of groupDrives) {
      resolvedByRoot.set(root, resolveDrives(list));
    }

    const changed: number[] = [];
    for (let i = 0; i < n; i++) {
      const nextVal = resolvedByRoot.get(findRoot(i)) ?? 'Z';
      if (nextVal !== netValues[i]) {
        netValues[i] = nextVal;
        changed.push(i);
      }
    }
    return changed;
  };

  const evalComponent = (inst: CompInstance, now: number): void => {
    if (!inst.model.eval) return;
    inst.model.eval({
      comp: inst.comp,
      part: inst.part,
      state: inst.state,
      read: (pinName: string): Logic => {
        const pin = findPin(inst.part, inst.comp.ref, pinName);
        const idx = pinToNetIdx.get(pinKey(inst.comp.id, pin.id));
        return idx !== undefined ? netValues[idx]! : 'Z';
      },
      drive: (pinName: string, v: Logic, strength: 'strong' | 'weak' = 'strong', delay?: number): void => {
        const pin = findPin(inst.part, inst.comp.ref, pinName);
        const pk = pinKey(inst.comp.id, pin.id);
        const prev = lastScheduled.get(pk);
        if (prev && prev.v === v && prev.strength === strength) return;
        lastScheduled.set(pk, { v, strength });
        const dt = delay ?? inst.delay;
        queue.push({ t: normalizeTime(now + dt), seq: seq++, kind: 'drive', compId: inst.comp.id, pinKey: pk, v, strength });
      },
    });
  };

  const changes: TraceChange[] = [];
  const t0ChangeIndex = new Map<number, number>();
  const recordChanges = (t: number, changed: number[]): void => {
    for (const idx of changed) {
      const net = netNames[idx]!;
      const v = netValues[idx]!;
      if (t === 0) {
        const existing = t0ChangeIndex.get(idx);
        if (existing !== undefined) {
          changes[existing]!.v = v;
        } else {
          t0ChangeIndex.set(idx, changes.length);
          changes.push({ t: 0, net, v });
        }
      } else {
        changes.push({ t, net, v });
      }
    }
  };

  // Initial t = 0 pre-stimulus settle (constants, initial switch states, pulls) and initial IC evaluation.
  const initChanged = resolveAllNets();
  recordChanges(0, initChanged);
  for (const inst of icComps.values()) evalComponent(inst, 0);

  const warnings: string[] = [];
  let settled = true;
  let totalEvents = 0;

  while (queue.size > 0) {
    const next = queue.peek()!;
    if (next.t > opts.until) {
      settled = false;
      break;
    }

    const t = next.t;
    let stepEvents = 0;
    let aborted = false;

    // Process delta cycles at timestamp `t` (multiple passes only if zero-delay events schedule at `t`).
    while (queue.size > 0 && queue.peek()!.t === t) {
      const affectedComps = new Set<string>();
      while (queue.size > 0 && queue.peek()!.t === t) {
        const ev = queue.pop()!;
        stepEvents += 1;
        totalEvents += 1;
        if (stepEvents > MAX_EVENTS_PER_STEP || totalEvents > MAX_TOTAL_EVENTS) {
          settled = false;
          warnings.push(`oscillation or non-settling circuit: event limit reached at t=${formatTimeSI(t)} (${totalEvents} events)`);
          aborted = true;
          break;
        }
        if (ev.kind === 'drive') {
          pinDrives.set(ev.pinKey, { v: ev.v, strength: ev.strength });
        } else {
          const sw = switches.get(ev.compId)!;
          if (sw.closed !== ev.closed) {
            sw.closed = ev.closed;
            if (sw.netA !== undefined) for (const cid of netToComps[sw.netA]!) affectedComps.add(cid);
            if (sw.netB !== undefined) for (const cid of netToComps[sw.netB]!) affectedComps.add(cid);
          }
        }
      }
      if (aborted) break;

      const changed = resolveAllNets();
      recordChanges(t, changed);
      for (const idx of changed) {
        for (const cid of netToComps[idx]!) affectedComps.add(cid);
      }

      if (affectedComps.size > 0) {
        const sortedIds = [...affectedComps].sort((a, b) => {
          const ca = icComps.get(a)!.comp.ref;
          const cb = icComps.get(b)!.comp.ref;
          return ca < cb ? -1 : ca > cb ? 1 : 0;
        });
        for (const cid of sortedIds) {
          const inst = icComps.get(cid);
          if (inst) evalComponent(inst, t);
        }
      }
    }

    if (aborted) break;
  }

  const filteredChanges = changes.filter(c => !(c.t === 0 && c.v === 'Z'));
  const final: Record<string, Logic> = {};
  for (let i = 0; i < nets.length; i++) final[netNames[i]!] = netValues[i]!;

  const trace: Trace = { nets: netNames, changes: filteredChanges, final, settled, warnings };
  return trace;
}

function resolveProbeNet(probe: string, traceNets: readonly string[], q?: Query): string | undefined {
  const upper = probe.toUpperCase();
  const direct = traceNets.find(n => n.toUpperCase() === upper);
  if (direct !== undefined) return direct;
  if (probe.includes('.')) {
    if (!q) throw new CadError('invalid', `cannot resolve pin probe "${probe}" without Query`);
    const resolved = q.resolvePin(probe);
    return q.netOfPin(resolved.key)?.name;
  }
  if (q) {
    q.requireNet(probe);
  }
  throw new CadError('unknown_net', `no net ${probe}`);
}

/** Enumerate all binary combinations of switch/button inputs and record settled outputs. */
export function truthTable(q: Query, inputs: string[], outputs: string[]): TruthTable {
  for (const ref of inputs) {
    const comp = q.requireComponent(ref);
    const simRef = q.part(comp).sim?.find(s => s.kind === 'logic');
    if (simRef?.ref !== 'switch') {
      throw new CadError('invalid', `truthTable input ${ref} is not a switch or button`);
    }
  }

  const netNames = q.nets().map(n => n.name);
  const outNets = outputs.map(o => resolveProbeNet(o, netNames, q));

  const n = inputs.length;
  const total = 1 << n;
  const rows: { in: Logic[]; out: Logic[] }[] = [];

  for (let r = 0; r < total; r++) {
    const inRow: Logic[] = [];
    const stimulus: StimulusEvent[] = [];
    for (let i = 0; i < n; i++) {
      const bit: Logic = ((r >> (n - 1 - i)) & 1) === 1 ? '1' : '0';
      inRow.push(bit);
      stimulus.push({ t: 0, ref: inputs[i]!, state: bit === '1' ? 'closed' : 'open' });
    }
    const trace = simulate(q, { until: 1, stimulus });
    const outRow: Logic[] = outNets.map(net => (net !== undefined ? (trace.final[net] ?? 'Z') : 'Z'));
    rows.push({ in: inRow, out: outRow });
  }

  return { inputs: [...inputs], outputs: [...outputs], rows };
}

/** Format a Trace as an aligned transition table showing only rows where a probed net changes. */
export function formatTransitions(trace: Trace, probes: string[], q?: Query): string {
  const probeNets = probes.map(p => resolveProbeNet(p, trace.nets, q));

  const cur: Logic[] = Array(probes.length).fill('Z');
  const rows: { tStr: string; vals: Logic[] }[] = [];

  let i = 0;
  const ch = trace.changes;
  while (i < ch.length) {
    const t = ch[i]!.t;
    const next = [...cur];
    while (i < ch.length && ch[i]!.t === t) {
      const entry = ch[i]!;
      for (let p = 0; p < probeNets.length; p++) {
        if (probeNets[p] === entry.net) next[p] = entry.v;
      }
      i += 1;
    }
    let changed = false;
    for (let p = 0; p < cur.length; p++) {
      if (next[p] !== cur[p]) {
        changed = true;
        cur[p] = next[p]!;
      }
    }
    if (changed) {
      rows.push({ tStr: formatTimeSI(t), vals: [...cur] });
    }
  }

  const shown = rows.slice(0, MAX_TRANSITION_ROWS);
  const tWidth = Math.max(1, ...shown.map(r => r.tStr.length));
  const widths = probes.map(p => Math.max(p.length, 1));

  const formatRow = (tCell: string, cells: readonly string[]): string => {
    const parts = [tCell.padEnd(tWidth)];
    for (let c = 0; c < cells.length; c++) {
      const s = cells[c]!;
      parts.push(c === cells.length - 1 ? s : s.padEnd(widths[c]!));
    }
    return parts.join(' ').trimEnd();
  };

  const lines = [formatRow('t', probes)];
  for (const r of shown) lines.push(formatRow(r.tStr, r.vals));
  if (rows.length > MAX_TRANSITION_ROWS) {
    lines.push(`… ${rows.length - MAX_TRANSITION_ROWS} more rows`);
  }
  return lines.join('\n');
}

/** Format a truth table into a compact, aligned text table. */
export function formatTruthTable(tt: TruthTable): string {
  const inW = tt.inputs.map(s => Math.max(s.length, 1));
  const outW = tt.outputs.map(s => Math.max(s.length, 1));

  const formatSide = (cells: readonly string[], widths: readonly number[], padLast: boolean): string =>
    cells.map((c, i) => (!padLast && i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join(' ');

  const lines: string[] = [];
  const inHdr = formatSide(tt.inputs, inW, true);
  const outHdr = formatSide(tt.outputs, outW, false);
  lines.push((inHdr ? `${inHdr} -> ${outHdr}` : `-> ${outHdr}`).trimEnd());

  for (const row of tt.rows) {
    const inStr = formatSide(row.in, inW, true);
    const outStr = formatSide(row.out, outW, false);
    lines.push((inStr ? `${inStr} -> ${outStr}` : `-> ${outStr}`).trimEnd());
  }
  return lines.join('\n');
}
