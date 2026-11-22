// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import {
  CadError,
  naturalCompare,
  parseSI,
  pinKey,
  Query,
  type Circuit,
  type Component,
  type Net,
  type PartDef,
  type PartResolver,
  type PinDef,
  type PinKey,
} from '@cadllm/core';
import { formatSI, operatingPoint, R_OUT, type LogicLevel, type OpResult } from '@cadllm/sim-analog';
import {
  DEFAULT_PROP_DELAY,
  findPin,
  formatTimeSI,
  logicModels,
  normalizeTime,
  parseSwitchState,
  resolveDrives,
  resolveStrong,
  type Drive,
  type Logic,
  type LogicModel,
  type StimulusEvent,
} from '@cadllm/sim-digital';
import { UNO_CLOCK_HZ, Uno, type UnoPinName, type UnoPinState } from '@cadllm/sim-mcu';

const DEFAULT_SLICE = 1e-4; // 100 us (exact 1600 AVR cycles at 16 MHz)
const AVR_CLOCK_HZ = UNO_CLOCK_HZ;
const PULLUP_OHMS = '35k';
const HIZ_LEAK_OHMS = '1G';
const MAX_EVENTS_PER_STEP = 1000;
const MAX_TOTAL_EVENTS = 100_000;
const MAX_MIXED_ROWS = 40;

const UNO_GPIO_PINS: ReadonlySet<UnoPinName> = new Set([
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
]);

const UNO_POWER_OUT: Record<string, string> = {
  '5V': '5',
  '3V3': '3.3',
  IOREF: '5',
};

const UNO_GND_PINS = new Set(['GND', 'GND2', 'GND3']);

export interface UnoLike {
  readonly serial: string;
  readonly time: number;
  pin(name: UnoPinName): UnoPinState;
  setInput(name: UnoPinName, level: Logic | number): void;
  run(seconds: number, onPinChange?: (t: number, pin: UnoPinName, level: Logic) => void): void;
}

export interface MixedChange {
  t: number;
  net: string;
  v: Logic;
}

export interface MixedAnalogSample {
  t: number;
  values: Record<string, number>;
}

export interface MixedTrace {
  changes: MixedChange[];
  analog: MixedAnalogSample[];
  serial: Record<string, string>;
  warnings: string[];
}

export interface MixedOptions {
  until: number;
  stimulus?: StimulusEvent[];
  probes: string[];
  firmware: Record<string, string>;
  /** Optional MCU factory (defaults to `new Uno(hex)`). */
  createUno?: (hex: string, comp: Component) => UnoLike;
  /** Time slice in seconds for stepping MCUs (default 100 us). */
  slice?: number;
}

type MixedEvent =
  | { t: number; seq: number; kind: 'drive'; pinKey: PinKey; v: Logic; strength: 'strong' | 'weak' }
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

interface LogicInst {
  comp: Component;
  part: PartDef;
  model: LogicModel;
  delay: number;
  state: Record<string, unknown>;
}

interface McuInst {
  comp: Component;
  uno: UnoLike;
  cycles: number;
  gpioPins: { name: UnoPinName; pk: PinKey; netIdx: number }[];
  lastInput: Map<UnoPinName, Logic | number>;
}

const VIRTUAL_PARTS: Record<string, PartDef> = {
  __vsrc: {
    id: '__vsrc',
    name: 'Virtual DC Source',
    summary: 'virtual source',
    category: 'source',
    refPrefix: 'V',
    pins: [
      { id: '+', name: '+', type: 'power_out' },
      { id: '-', name: '-', type: 'power_in' },
    ],
    props: { voltage: { type: 'number', default: '5' } },
    sim: [{ kind: 'spice', ref: 'V' }],
  },
  __res: {
    id: '__res',
    name: 'Virtual Resistor',
    summary: 'virtual resistor',
    category: 'passive',
    refPrefix: 'R',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: { resistance: { type: 'number', default: '50' } },
    sim: [{ kind: 'spice', ref: 'R' }],
  },
  __gnd: {
    id: '__gnd',
    name: 'Virtual Ground',
    summary: 'virtual ground',
    category: 'source',
    refPrefix: 'GND',
    pins: [{ id: '1', name: 'GND', type: 'power_in' }],
    sim: [{ kind: 'spice', ref: 'GND' }],
  },
};

function wrapParts(base: PartResolver): PartResolver {
  return {
    get(id: string): PartDef | undefined {
      return VIRTUAL_PARTS[id] ?? base.get(id);
    },
  };
}

function evalConstDrives(comp: Component, part: PartDef): { pinId: string; v: Logic }[] {
  const out: { pinId: string; v: Logic }[] = [];
  const voltage = comp.props.voltage !== undefined ? parseSI(comp.props.voltage) : undefined;
  const high: Logic = (voltage ?? 5) >= 2 ? '1' : '0';
  for (const pin of part.pins) {
    const n = pin.name.toLowerCase();
    if (n === '+' || n === 'vcc') out.push({ pinId: pin.id, v: high });
    else if (n === '-' || n === 'gnd') out.push({ pinId: pin.id, v: '0' });
  }
  if (out.length === 0) findPin(part, comp.ref, part.pins[0]?.name ?? '+');
  return out;
}

function lookupCI<T>(rec: Record<string, T>, key: string): T | undefined {
  if (Object.hasOwn(rec, key)) return rec[key];
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

function lookupFirmware(firmware: Record<string, string>, ref: string): string | undefined {
  const direct = lookupCI(firmware, ref);
  return direct;
}

function isAnalogProbe(probe: string): boolean {
  return /^[VI]\([^)]+\)$/i.test(probe.trim());
}

function resolveAnalogProbeValue(q: Query, r: OpResult, probe: string): number {
  const m = probe.trim().match(/^([VI])\(([^)]+)\)$/i)!;
  const kind = m[1]!.toUpperCase();
  const target = m[2]!.trim();
  if (kind === 'I') {
    const ref = q.requireComponent(target).ref;
    const val = lookupCI(r.i, ref);
    if (val === undefined) {
      throw new CadError('invalid', `no current for ${ref}`, 'currents exist for two-pin parts and sources');
    }
    return val;
  }
  if (target.includes('.')) {
    const direct = lookupCI(r.v, target);
    if (direct !== undefined) return direct;
    const resolved = q.resolvePin(target);
    const net = q.netOfPin(resolved.key);
    if (!net) throw new CadError('invalid', `pin ${target} is unconnected`);
    const val = lookupCI(r.v, net.name);
    if (val === undefined) throw new CadError('unknown_net', `no voltage for ${probe}`);
    return val;
  }
  const val = lookupCI(r.v, q.requireNet(target).name);
  if (val === undefined) throw new CadError('unknown_net', `no voltage for ${target}`);
  return val;
}

function findReferenceGndNet(q: Query, comps: Component[]): Net | undefined {
  for (const comp of comps) {
    const part = q.part(comp);
    if (part.sim?.find(s => s.kind === 'spice')?.ref !== 'GND') continue;
    const pin = part.pins[0];
    const net = pin ? q.netOfPin(pinKey(comp.id, pin.id)) : undefined;
    if (net) return net;
  }
  const named = q.net('GND');
  if (named) return named;
  for (const comp of comps) {
    const part = q.part(comp);
    if (part.sim?.find(s => s.kind === 'spice')?.ref !== 'V') continue;
    const neg = part.pins.find(p => ['-', 'neg', '2'].includes(p.name.toLowerCase())) ?? part.pins[1];
    const net = neg ? q.netOfPin(pinKey(comp.id, neg.id)) : undefined;
    if (net) return net;
  }
  for (const comp of comps) {
    const part = q.part(comp);
    if (!part.sim?.some(s => s.kind === 'mcu')) continue;
    for (const p of part.pins) {
      if (!UNO_GND_PINS.has(p.name.toUpperCase())) continue;
      const net = q.netOfPin(pinKey(comp.id, p.id));
      if (net) return net;
    }
  }
  return undefined;
}

function buildAnalogQuery(
  q: Query,
  switches: ReadonlyMap<string, SwitchLink>,
  mcus: readonly McuInst[],
  parts: PartResolver,
): Query | undefined {
  const comps = q.components();
  const refNet = findReferenceGndNet(q, comps);
  if (!refNet) return undefined;

  const components: Record<string, Component> = {};
  for (const c of comps) {
    const sw = switches.get(c.id);
    components[c.id] = sw
      ? { ...c, props: { ...c.props, state: sw.closed ? 'closed' : 'open' } }
      : { ...c, props: { ...c.props } };
  }

  const nets: Record<string, Net> = {};
  for (const n of q.nets()) {
    nets[n.id] = { id: n.id, name: n.name, pins: [...n.pins] };
  }

  let vSeq = 0;
  const addVirtComp = (partId: string, props: Record<string, string>, pinNets: Record<string, string>): void => {
    const id = `__virt_${vSeq++}`;
    components[id] = { id, ref: id, part: partId, props, place: {} };
    for (const [pinId, netId] of Object.entries(pinNets)) {
      nets[netId]!.pins.push(pinKey(id, pinId));
    }
  };

  // Ensure operatingPoint sees a GND reference if only MCU GND was present.
  const hasRealRef = comps.some(c => {
    const sr = q.part(c).sim?.find(s => s.kind === 'spice')?.ref;
    return sr === 'GND' || sr === 'V';
  }) || q.net('GND') !== undefined;
  if (!hasRealRef) {
    addVirtComp('__gnd', {}, { '1': refNet.id });
  }

  // Track nets already driven by an explicit voltage source to avoid parallel ideal V sources.
  const drivenByVSource = new Set<string>();
  for (const c of comps) {
    const part = q.part(c);
    const sr = part.sim?.find(s => s.kind === 'spice')?.ref;
    if (sr !== 'V' && sr !== 'VSYM') continue;
    const pos = part.pins.find(p => ['+', 'pos', 'vcc', '1'].includes(p.name.toLowerCase())) ?? part.pins[0];
    const net = pos ? q.netOfPin(pinKey(c.id, pos.id)) : undefined;
    if (net) drivenByVSource.add(net.id);
  }

  let vccNetId: string | undefined;
  const ensureVccNet = (): string => {
    if (vccNetId) return vccNetId;
    vccNetId = '__virt_net_5v';
    nets[vccNetId] = { id: vccNetId, name: '__VIRT_5V', pins: [] };
    addVirtComp('__vsrc', { voltage: '5' }, { '+': vccNetId, '-': refNet.id });
    return vccNetId;
  };

  for (const mcu of mcus) {
    const part = q.part(mcu.comp);
    for (const pin of part.pins) {
      const net = q.netOfPin(pinKey(mcu.comp.id, pin.id));
      if (!net) continue;
      const up = pin.name.toUpperCase();
      if (up in UNO_POWER_OUT && !drivenByVSource.has(net.id)) {
        drivenByVSource.add(net.id);
        addVirtComp('__vsrc', { voltage: UNO_POWER_OUT[up]! }, { '+': net.id, '-': refNet.id });
      } else if (UNO_GND_PINS.has(up) && net.id !== refNet.id && !drivenByVSource.has(net.id)) {
        drivenByVSource.add(net.id);
        addVirtComp('__vsrc', { voltage: '0' }, { '+': net.id, '-': refNet.id });
      }
    }

    for (const gp of mcu.gpioPins) {
      const net = q.netOfPin(gp.pk);
      if (!net) continue;
      const st = mcu.uno.pin(gp.name);
      if (st.mode === 'output') {
        if (st.level === '1') {
          addVirtComp('__res', { resistance: String(R_OUT) }, { '1': ensureVccNet(), '2': net.id });
        } else if (st.level === '0') {
          addVirtComp('__res', { resistance: String(R_OUT) }, { '1': net.id, '2': refNet.id });
        }
      } else if (st.mode === 'input_pullup') {
        addVirtComp('__res', { resistance: PULLUP_OHMS }, { '1': ensureVccNet(), '2': net.id });
      } else if (net.id !== refNet.id) {
        addVirtComp('__res', { resistance: HIZ_LEAK_OHMS }, { '1': net.id, '2': refNet.id });
      }
    }
  }

  const augCircuit: Circuit = { meta: q.circuit.meta, seq: q.circuit.seq, components, nets };
  return new Query(augCircuit, parts);
}

/** Run event-driven mixed-signal co-simulation (MCU + 4-state digital + quasi-static analog DC). */
export function runMixed(q: Query, opts: MixedOptions): MixedTrace {
  if (!Number.isFinite(opts.until) || opts.until < 0) {
    throw new CadError('invalid', 'runMixed: until must be >= 0');
  }
  const slice = opts.slice ?? DEFAULT_SLICE;
  if (!Number.isFinite(slice) || slice <= 0) {
    throw new CadError('invalid', 'runMixed: slice must be > 0');
  }

  const nets = q.nets();
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

  const logicComps = new Map<string, LogicInst>();
  const switches = new Map<string, SwitchLink>();
  const pulls: PullLink[] = [];
  const mcus: McuInst[] = [];

  for (const comp of q.components()) {
    const part = q.part(comp);
    const mcuSim = part.sim?.find(s => s.kind === 'mcu');
    if (mcuSim) {
      const hex = lookupFirmware(opts.firmware, comp.ref);
      if (hex === undefined) {
        throw new CadError('invalid', `${comp.ref}: missing firmware`, `add [code ${comp.ref}]`);
      }
      const uno = opts.createUno ? opts.createUno(hex, comp) : new Uno(hex);
      const gpioPins: McuInst['gpioPins'] = [];
      for (const pin of part.pins) {
        const up = pin.name.toUpperCase();
        const pk = pinKey(comp.id, pin.id);
        const netIdx = pinToNetIdx.get(pk);
        if (up in UNO_POWER_OUT) {
          pinDrives.set(pk, { v: '1', strength: 'strong' });
        } else if (UNO_GND_PINS.has(up)) {
          pinDrives.set(pk, { v: '0', strength: 'strong' });
        } else if (UNO_GPIO_PINS.has(up as UnoPinName) && netIdx !== undefined) {
          gpioPins.push({ name: up as UnoPinName, pk, netIdx });
        }
      }
      mcus.push({ comp, uno, cycles: 0, gpioPins, lastInput: new Map() });
      continue;
    }

    const simRef = part.sim?.find(s => s.kind === 'logic');
    if (!simRef) continue;
    const model = logicModels.get(simRef.ref);
    if (!model) throw new CadError('invalid', `${comp.ref}: unknown logic model "${simRef.ref}"`);

    if (model.role === 'const') {
      for (const { pinId, v } of evalConstDrives(comp, part)) {
        pinDrives.set(pinKey(comp.id, pinId), { v, strength: 'strong' });
      }
      continue;
    }
    if (model.role === 'switch') {
      const p1 = findPin(part, comp.ref, '1');
      const p2 = findPin(part, comp.ref, '2');
      switches.set(comp.id, {
        compId: comp.id,
        netA: pinToNetIdx.get(pinKey(comp.id, p1.id)),
        netB: pinToNetIdx.get(pinKey(comp.id, p2.id)),
        closed: parseSwitchState(comp.props.state ?? 'open', comp.ref),
      });
      continue;
    }
    if (model.role === 'pull') {
      const p1 = findPin(part, comp.ref, '1');
      const p2 = findPin(part, comp.ref, '2');
      pulls.push({
        netA: pinToNetIdx.get(pinKey(comp.id, p1.id)),
        netB: pinToNetIdx.get(pinKey(comp.id, p2.id)),
      });
      continue;
    }
    if (model.role === 'probe') continue;

    let delay = model.delay ?? DEFAULT_PROP_DELAY;
    if (comp.props.delay !== undefined) {
      const parsed = parseSI(comp.props.delay);
      if (parsed === undefined || parsed < 0) {
        throw new CadError('invalid', `${comp.ref}: invalid delay "${comp.props.delay}"`, 'use e.g. 10n, 5ns, 1u');
      }
      delay = parsed;
    }
    logicComps.set(comp.id, {
      comp,
      part,
      model,
      delay,
      state: model.init ? model.init(comp, part) : {},
    });
    for (const pin of part.pins) {
      const nIdx = pinToNetIdx.get(pinKey(comp.id, pin.id));
      if (nIdx !== undefined) netToComps[nIdx]!.add(comp.id);
    }
  }

  let seq = 0;
  const queue = new MinHeap<MixedEvent>((a, b) => (a.t - b.t) || (a.seq - b.seq));
  const stimulusTimes: number[] = [];

  if (opts.stimulus) {
    for (const ev of opts.stimulus) {
      if (!Number.isFinite(ev.t) || ev.t < 0) {
        throw new CadError('invalid', `stimulus: invalid time ${ev.t} for ${ev.ref}`);
      }
      const comp = q.requireComponent(ev.ref);
      const sw = switches.get(comp.id);
      if (!sw) throw new CadError('invalid', `stimulus target ${ev.ref} is not a switch or button`);
      const closed = parseSwitchState(ev.state, ev.ref);
      const t = normalizeTime(ev.t);
      if (t <= opts.until) {
        queue.push({ t, seq: seq++, kind: 'switch', compId: comp.id, closed });
        stimulusTimes.push(t);
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

  const resolveAllNets = (): { changed: number[]; strongContention: Set<number> } => {
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
    const strongContention = new Set<number>();
    for (const [root, list] of groupDrives) {
      const sv = resolveStrong(list);
      if (sv !== 'Z') strongByRoot.set(root, sv);
      if (sv === 'X') strongContention.add(root);
    }

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
    return { changed, strongContention };
  };

  const evalLogicComp = (inst: LogicInst, now: number): void => {
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
        queue.push({ t: normalizeTime(now + dt), seq: seq++, kind: 'drive', pinKey: pk, v, strength });
      },
    });
  };

  const syncMcuPinsToDrives = (): boolean => {
    let anyChanged = false;
    for (const mcu of mcus) {
      for (const gp of mcu.gpioPins) {
        const st = mcu.uno.pin(gp.name);
        const next: Drive = st.mode === 'output'
          ? { v: st.level, strength: 'strong' }
          : st.mode === 'input_pullup'
            ? { v: '1', strength: 'weak' }
            : { v: 'Z', strength: 'strong' };
        const prev = pinDrives.get(gp.pk);
        if (!prev || prev.v !== next.v || prev.strength !== next.strength) {
          pinDrives.set(gp.pk, next);
          anyChanged = true;
        }
      }
    }
    return anyChanged;
  };

  const changes: MixedChange[] = [];
  const t0ChangeIdx = new Map<number, number>();
  const recordChanges = (t: number, changed: number[]): void => {
    for (const idx of changed) {
      const net = netNames[idx]!;
      const v = netValues[idx]!;
      if (t === 0) {
        const existing = t0ChangeIdx.get(idx);
        if (existing !== undefined) {
          changes[existing]!.v = v;
        } else {
          t0ChangeIdx.set(idx, changes.length);
          changes.push({ t: 0, net, v });
        }
      } else {
        changes.push({ t, net, v });
      }
    }
  };

  const analogProbes = opts.probes.filter(isAnalogProbe);
  const partsWithVirtual = wrapParts(q.parts);
  const analogSamples: MixedAnalogSample[] = [];
  const warnings: string[] = [];
  let lastAnalogOp: OpResult | undefined;
  let warnedNonConverged = false;

  const solveAnalogAt = (t: number): void => {
    const augQ = buildAnalogQuery(q, switches, mcus, partsWithVirtual);
    if (!augQ) {
      if (analogProbes.length > 0) {
        // Trigger the canonical CadError from operatingPoint when analog probes were explicitly requested.
        operatingPoint(q);
      }
      lastAnalogOp = undefined;
      return;
    }

    const logicMap: Record<string, LogicLevel> = {};
    for (let i = 0; i < nets.length; i++) {
      logicMap[netNames[i]!] = netValues[i]!;
    }
    let op: OpResult;
    try {
      op = operatingPoint(augQ, { logic: logicMap });
    } catch (err) {
      if (err instanceof CadError && /floating net/i.test(err.message) && (analogProbes.length === 0 || (t === 0 && queue.size > 0))) {
        lastAnalogOp = undefined;
        return;
      }
      throw err;
    }
    lastAnalogOp = op;
    if (!op.converged && !warnedNonConverged) {
      warnedNonConverged = true;
      warnings.push(`t=${formatTimeSI(t)}: analog DC did not converge (${op.reason ?? 'unknown'})`);
    }

    if (analogProbes.length > 0) {
      const values: Record<string, number> = {};
      for (const probe of analogProbes) {
        values[probe] = resolveAnalogProbeValue(augQ, op, probe);
      }
      const last = analogSamples[analogSamples.length - 1];
      if (last && last.t === t) {
        last.values = values;
      } else {
        analogSamples.push({ t, values });
      }
    }
  };

  const feedInputsToMcus = (strongContention: Set<number>): void => {
    for (const mcu of mcus) {
      for (const gp of mcu.gpioPins) {
        const st = mcu.uno.pin(gp.name);
        if (st.mode === 'output') continue;
        const netLogic = netValues[gp.netIdx]!;
        let inputVal: Logic | number = netLogic;
        const isContended = strongContention.has(findRoot(gp.netIdx));
        if (lastAnalogOp && lastAnalogOp.converged && !isContended) {
          const v = lastAnalogOp.v[netNames[gp.netIdx]!];
          if (v !== undefined && Number.isFinite(v) && (netLogic !== 'Z' || Math.abs(v) > 1e-6)) {
            inputVal = v;
          }
        }
        const prev = mcu.lastInput.get(gp.name);
        if (prev !== inputVal) {
          mcu.lastInput.set(gp.name, inputVal);
          mcu.uno.setInput(gp.name, inputVal);
        }
      }
    }
  };

  let totalEvents = 0;
  let aborted = false;

  const processEventsUpTo = (limitT: number): void => {
    while (queue.size > 0 && queue.peek()!.t <= limitT) {
      const t = queue.peek()!.t;
      let stepEvents = 0;
      let anySwitchChanged = false;
      let anyNetChanged = false;
      let lastContention = new Set<number>();

      while (queue.size > 0 && queue.peek()!.t === t) {
        const affectedComps = new Set<string>();
        while (queue.size > 0 && queue.peek()!.t === t) {
          const ev = queue.pop()!;
          stepEvents += 1;
          totalEvents += 1;
          if (stepEvents > MAX_EVENTS_PER_STEP || totalEvents > MAX_TOTAL_EVENTS) {
            warnings.push(`oscillation or non-settling circuit: event limit reached at t=${formatTimeSI(t)}`);
            aborted = true;
            break;
          }
          if (ev.kind === 'drive') {
            pinDrives.set(ev.pinKey, { v: ev.v, strength: ev.strength });
          } else {
            const sw = switches.get(ev.compId)!;
            if (sw.closed !== ev.closed) {
              sw.closed = ev.closed;
              anySwitchChanged = true;
              if (sw.netA !== undefined) for (const cid of netToComps[sw.netA]!) affectedComps.add(cid);
              if (sw.netB !== undefined) for (const cid of netToComps[sw.netB]!) affectedComps.add(cid);
            }
          }
        }
        if (aborted) break;

        const { changed, strongContention } = resolveAllNets();
        lastContention = strongContention;
        if (changed.length > 0) {
          anyNetChanged = true;
          recordChanges(t, changed);
          for (const idx of changed) {
            for (const cid of netToComps[idx]!) affectedComps.add(cid);
          }
        }

        if (affectedComps.size > 0) {
          const sortedIds = [...affectedComps].sort((a, b) => naturalCompare(logicComps.get(a)!.comp.ref, logicComps.get(b)!.comp.ref));
          for (const cid of sortedIds) {
            const inst = logicComps.get(cid);
            if (inst) evalLogicComp(inst, t);
          }
        }
      }

      if (aborted) break;
      if (anyNetChanged || anySwitchChanged) {
        solveAnalogAt(t);
        feedInputsToMcus(lastContention);
      }
    }
  };

  // Initial t = 0 settle before running MCUs.
  syncMcuPinsToDrives();
  const initRes = resolveAllNets();
  recordChanges(0, initRes.changed);
  for (const inst of logicComps.values()) evalLogicComp(inst, 0);
  solveAnalogAt(0);
  feedInputsToMcus(initRes.strongContention);
  processEventsUpTo(0);

  let now = 0;
  const sortedStim = [...new Set(stimulusTimes)].sort((a, b) => a - b);
  let stimIdx = 0;
  while (stimIdx < sortedStim.length && sortedStim[stimIdx]! <= 0) stimIdx++;

  while (now < opts.until && !aborted) {
    let tNext = mcus.length > 0 ? Math.min(opts.until, normalizeTime(now + slice)) : opts.until;
    while (stimIdx < sortedStim.length && sortedStim[stimIdx]! <= now) stimIdx++;
    if (stimIdx < sortedStim.length && sortedStim[stimIdx]! < tNext) {
      tNext = sortedStim[stimIdx]!;
    }
    const nextQueued = queue.peek();
    if (nextQueued && nextQueued.t < tNext) {
      tNext = nextQueued.t;
    }

    if (tNext > now && mcus.length > 0) {
      const targetCycles = Math.round(tNext * AVR_CLOCK_HZ);
      for (const mcu of mcus) {
        const deltaCycles = targetCycles - mcu.cycles;
        if (deltaCycles <= 0) continue;
        const dt = deltaCycles / AVR_CLOCK_HZ;
        const sliceChanges = new Map<UnoPinName, { t: number; level: Logic }[]>();
        mcu.uno.run(dt, (evT, pin, level) => {
          const nt = normalizeTime(evT);
          let list = sliceChanges.get(pin);
          if (!list) {
            list = [];
            sliceChanges.set(pin, list);
          }
          list.push({ t: nt, level });
        });
        mcu.cycles = targetCycles;

        // Reconcile pin mode (output vs input_pullup vs input) for events in this slice.
        for (const gp of mcu.gpioPins) {
          const st = mcu.uno.pin(gp.name);
          const events = sliceChanges.get(gp.name);
          if (events && events.length > 0) {
            for (let k = 0; k < events.length; k++) {
              const ev = events[k]!;
              const isLast = k === events.length - 1;
              let v: Logic = ev.level;
              let strength: 'strong' | 'weak' = 'strong';
              if (isLast) {
                if (st.mode === 'input_pullup') {
                  v = '1';
                  strength = 'weak';
                } else if (st.mode === 'input') {
                  v = 'Z';
                  strength = 'strong';
                } else {
                  v = st.level;
                }
              } else if (ev.level === 'Z') {
                v = 'Z';
              }
              queue.push({ t: ev.t, seq: seq++, kind: 'drive', pinKey: gp.pk, v, strength });
            }
          } else {
            const expected: Drive = st.mode === 'output'
              ? { v: st.level, strength: 'strong' }
              : st.mode === 'input_pullup'
                ? { v: '1', strength: 'weak' }
                : { v: 'Z', strength: 'strong' };
            const prev = pinDrives.get(gp.pk);
            if (!prev || prev.v !== expected.v || prev.strength !== expected.strength) {
              queue.push({ t: tNext, seq: seq++, kind: 'drive', pinKey: gp.pk, v: expected.v, strength: expected.strength });
            }
          }
        }
      }
    }

    now = tNext;
    processEventsUpTo(now);
  }

  const filteredChanges = changes.filter(c => !(c.t === 0 && c.v === 'Z'));
  const serial: Record<string, string> = {};
  for (const mcu of mcus) {
    serial[mcu.comp.ref] = mcu.uno.serial;
  }

  return { changes: filteredChanges, analog: analogSamples, serial, warnings };
}

function resolveDigitalProbeNet(probe: string, knownNets: readonly string[], q?: Query): string | undefined {
  const upper = probe.toUpperCase();
  const direct = knownNets.find(n => n.toUpperCase() === upper);
  if (direct !== undefined) return direct;
  if (probe.includes('.')) {
    if (q) {
      const resolved = q.resolvePin(probe);
      return q.netOfPin(resolved.key)?.name;
    }
    const suffix = probe.slice(probe.indexOf('.') + 1).toUpperCase();
    return knownNets.find(n => n.toUpperCase() === suffix);
  }
  if (q) q.requireNet(probe);
  return undefined;
}

/** Format a MixedTrace as an aligned transition table (rows only where a probed value changes, capped at 40 rows). */
export function formatMixed(trace: MixedTrace, probes: string[], q?: Query): string {
  const knownNets = [...new Set(trace.changes.map(c => c.net))].sort(naturalCompare);
  const cols = probes.length > 0
    ? probes
    : [
        ...knownNets,
        ...Object.keys(trace.analog[0]?.values ?? {}).sort(naturalCompare),
      ];
  if (cols.length === 0) return '(no changes)';

  const isAnalogCol = cols.map(isAnalogProbe);
  const digitalNets = cols.map((p, i) => (isAnalogCol[i] ? undefined : resolveDigitalProbeNet(p, knownNets, q)));

  const timestamps = new Set<number>();
  for (const c of trace.changes) timestamps.add(c.t);
  for (const a of trace.analog) timestamps.add(a.t);
  const sortedT = [...timestamps].sort((a, b) => a - b);

  const cur: string[] = cols.map((_, i) => (isAnalogCol[i] ? '-' : 'Z'));
  const rows: { tStr: string; vals: string[] }[] = [];

  let chIdx = 0;
  let anIdx = 0;
  for (const t of sortedT) {
    const next = [...cur];
    while (chIdx < trace.changes.length && trace.changes[chIdx]!.t === t) {
      const ch = trace.changes[chIdx]!;
      for (let p = 0; p < cols.length; p++) {
        if (!isAnalogCol[p] && digitalNets[p] === ch.net) {
          next[p] = ch.v;
        }
      }
      chIdx++;
    }
    while (anIdx < trace.analog.length && trace.analog[anIdx]!.t === t) {
      const sample = trace.analog[anIdx]!;
      for (let p = 0; p < cols.length; p++) {
        if (isAnalogCol[p]) {
          const val = lookupCI(sample.values, cols[p]!);
          if (val !== undefined) next[p] = formatSI(val);
        }
      }
      anIdx++;
    }

    let changed = false;
    for (let p = 0; p < cols.length; p++) {
      if (next[p] !== cur[p]) {
        changed = true;
        cur[p] = next[p]!;
      }
    }
    if (changed) {
      rows.push({ tStr: formatTimeSI(t), vals: [...cur] });
    }
  }

  if (rows.length === 0) return '(no changes)';

  const shown = rows.slice(0, MAX_MIXED_ROWS);
  const tWidth = Math.max(1, ...shown.map(r => r.tStr.length));
  const widths = cols.map((c, i) => Math.max(c.length, ...shown.map(r => r.vals[i]!.length), 1));

  const formatRow = (tCell: string, cells: readonly string[]): string => {
    const parts = [tCell.padEnd(tWidth)];
    for (let c = 0; c < cells.length; c++) {
      const s = cells[c]!;
      parts.push(c === cells.length - 1 ? s : s.padEnd(widths[c]!));
    }
    return parts.join(' ').trimEnd();
  };

  const lines = [formatRow('t', cols)];
  for (const r of shown) lines.push(formatRow(r.tStr, r.vals));
  if (rows.length > MAX_MIXED_ROWS) {
    lines.push(`… ${rows.length - MAX_MIXED_ROWS} more`);
  }
  return lines.join('\n');
}
