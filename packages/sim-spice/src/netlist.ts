// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, naturalCompare, parseSI, pinKey, type Component, type Net, type PartDef, type PinDef, type Query } from '@cadllm/core';
import { LED_MODELS, MIN_POT_R, SWITCH_R_OFF, SWITCH_R_ON, type LedColor } from '@cadllm/sim-analog';
import { emitModels, ledModelName, zenerModelName } from './models.ts';
import type { SpiceAnalysis, SpiceNetlistOptions } from './types.ts';

export interface BuiltSpiceCircuit {
  netlist: string;
  refNetName: string;
  /** Lowercase SPICE node name -> CadLLM net name. */
  nodeMap: Map<string, string>;
  /** Lowercase SPICE voltage source name -> CadLLM component ref (currents need sign negation). */
  sourceMap: Map<string, string>;
  /** Lowercase SPICE 0V sense source name -> requested probe keys (`I(REF)` / `I(REF.PIN)`). */
  senseMap: Map<string, string[]>;
  /** Requested pin voltage probes (`V(REF.PIN)`) -> `{ probeKey, netName }`. */
  pinProbes: Array<{ probeKey: string; netName: string }>;
  /** Requested net voltage probes (`V(NET)`) -> `{ probeKey, netName }`. */
  netProbes: Array<{ probeKey: string; netName: string }>;
  /** Requested current probes on completely unconnected components (`I(REF)` -> 0). */
  zeroCurrentProbes: string[];
}

const POWER_NET_RE = /^(VCC|VDD|V\+|V-|VSS|GND|VSUPPLY)$/i;

function findPin(part: PartDef, names: string[], fallbackIdx: number): PinDef {
  for (const target of names) {
    const lw = target.toLowerCase();
    const found =
      part.pins.find(p => p.id === target) ??
      part.pins.find(p => p.name.toLowerCase() === lw) ??
      part.pins.find(p => p.aliases?.some(a => a.toLowerCase() === lw));
    if (found) return found;
  }
  const fb = part.pins[fallbackIdx];
  if (!fb) throw new CadError('invalid', `part ${part.id} is missing expected pin ${names[0] ?? fallbackIdx}`);
  return fb;
}

function parseNumberProp(comp: Component, part: PartDef, key: string, positive = false): number {
  const raw = comp.props[key] ?? part.props?.[key]?.default;
  if (raw === undefined) {
    throw new CadError('invalid', `${comp.ref}: missing required property "${key}"`);
  }
  const val = parseSI(raw);
  if (val === undefined || !Number.isFinite(val) || (positive && val <= 0)) {
    throw new CadError('invalid', `${comp.ref}: invalid ${key} value "${raw}"`);
  }
  return val;
}

function pickReferenceNet(q: Query, comps: Component[]): Net {
  const nets = q.nets();
  const gndNets = new Set<Net>();
  for (const comp of comps) {
    const part = q.part(comp);
    if (part.sim?.find(s => s.kind === 'spice')?.ref !== 'GND') continue;
    const pin = findPin(part, ['GND', '1'], 0);
    const net = q.netOfPin(pinKey(comp.id, pin.id));
    if (net) gndNets.add(net);
  }
  if (gndNets.size > 0) {
    const sorted = [...gndNets].sort((a, b) => naturalCompare(a.name, b.name));
    return sorted.find(n => n.name.toUpperCase() === 'GND') ?? sorted[0]!;
  }

  const namedGnd = q.net('GND');
  if (namedGnd) return namedGnd;

  for (const comp of comps) {
    const part = q.part(comp);
    if (part.sim?.find(s => s.kind === 'spice')?.ref !== 'V') continue;
    const negPin = findPin(part, ['-', 'neg', '2'], 1);
    const net = q.netOfPin(pinKey(comp.id, negPin.id));
    if (net) return net;
  }

  if (nets.length === 0) {
    throw new CadError('invalid', 'circuit has no nets or reference node');
  }
  throw new CadError('invalid', 'no reference node: add a gnd_symbol, a GND net, or a voltage source');
}

function makeUniqueName(raw: string, usedLower: Set<string>, prefix = ''): string {
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '_');
  let base = prefix && !clean.toUpperCase().startsWith(prefix.toUpperCase()) ? `${prefix}_${clean}` : clean;
  if (!/^[A-Za-z]/.test(base)) base = `${prefix || 'n'}_${base}`;
  let cand = base;
  for (let n = 2; usedLower.has(cand.toLowerCase()); n++) cand = `${base}_${n}`;
  usedLower.add(cand.toLowerCase());
  return cand;
}

function pickAcSourceId(q: Query, comps: Component[]): string | undefined {
  const candidates: Array<{ comp: Component; part: PartDef; rank: number }> = [];
  for (const comp of comps) {
    const part = q.part(comp);
    const spiceRef = part.sim?.find(s => s.kind === 'spice')?.ref;
    if (spiceRef !== 'V' && spiceRef !== 'VSYM') continue;
    if (!part.pins.some(p => q.netOfPin(pinKey(comp.id, p.id)) !== undefined)) continue;

    const posPin = spiceRef === 'VSYM' ? findPin(part, ['VCC', '1'], 0) : findPin(part, ['+', 'pos', '1'], 0);
    const net = q.netOfPin(pinKey(comp.id, posPin.id));
    const feedsPowerPin = net?.pins.some(pk => {
      const [cid, pid] = pk.split(':') as [string, string];
      if (cid === comp.id) return false;
      const target = q.circuit.components[cid];
      const pdef = target ? q.parts.get(target.part) : undefined;
      return pdef?.pins.find(p => p.id === pid)?.type === 'power_in';
    });

    let rank = 4;
    if (part.id === 'dc_supply') {
      rank = net && (POWER_NET_RE.test(net.name) || feedsPowerPin) ? 2 : 1;
    } else if (part.id === 'battery') {
      rank = 3;
    }
    candidates.push({ comp, part, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank || naturalCompare(a.comp.ref, b.comp.ref));
  return candidates[0]?.comp.id;
}

/** Format a SpiceAnalysis directive into SPICE netlist syntax. */
export function formatAnalysisCard(analysis: SpiceAnalysis, useUic = false): string {
  switch (analysis.kind) {
    case 'op':
      return '.op';
    case 'tran': {
      const step = analysis.step ?? analysis.stop / 500;
      const parts = ['.tran', String(step), String(analysis.stop)];
      if (analysis.start !== undefined) parts.push(String(analysis.start));
      if (analysis.uic ?? useUic) parts.push('uic');
      return parts.join(' ');
    }
    case 'ac':
      return `.ac ${analysis.sweep} ${analysis.points} ${analysis.start} ${analysis.stop}`;
  }
}

/** Build a SPICE netlist plus bidirectional symbol maps for CadLLM result mapping. */
export function buildSpiceCircuit(q: Query, opts: SpiceNetlistOptions = {}): BuiltSpiceCircuit {
  const comps = q.components();
  const nets = q.nets();
  const refNet = pickReferenceNet(q, comps);

  // Validate parts first (surface clear CadError for logic ICs before building netlist)
  for (const comp of comps) {
    const part = q.part(comp);
    const spiceSim = part.sim?.find(s => s.kind === 'spice');
    const logicSim = part.sim?.find(s => s.kind === 'logic');
    if (!spiceSim && logicSim && logicSim.ref !== 'probe') {
      throw new CadError(
        'invalid',
        `${comp.ref}: logic IC "${part.id}" (${part.name}) is not supported in SPICE simulation for M2`,
        'use logic or dc analysis instead',
      );
    }
  }

  const usedNodesLower = new Set<string>(['0', 'gnd']);
  const netToSpiceNode = new Map<string, string>([[refNet.id, '0']]);
  const nodeMap = new Map<string, string>();
  for (const net of nets) {
    if (net.id === refNet.id) continue;
    const nodeName = /^[A-Za-z][A-Za-z0-9_]*$/.test(net.name) && !usedNodesLower.has(net.name.toLowerCase())
      ? (usedNodesLower.add(net.name.toLowerCase()), net.name)
      : makeUniqueName(net.name, usedNodesLower, 'n');
    netToSpiceNode.set(net.id, nodeName);
    nodeMap.set(nodeName.toLowerCase(), net.name);
  }

  const pinProbes: Array<{ probeKey: string; netName: string }> = [];
  const netProbes: Array<{ probeKey: string; netName: string }> = [];
  const sensePins = new Map<string, string[]>();
  const addSensePin = (key: string, label: string) => {
    const list = sensePins.get(key) ?? [];
    if (!list.includes(label)) list.push(label);
    sensePins.set(key, list);
  };
  const zeroCurrentProbes: string[] = [];

  for (const rawProbe of opts.probes ?? []) {
    const probe = rawProbe.trim();
    const m = probe.match(/^([VI])\(([^)]+)\)$/i);
    if (!m) {
      throw new CadError('invalid', `bad probe "${probe}"`, 'use V(NET), V(REF.PIN), or I(REF)');
    }
    const kind = m[1]!.toUpperCase();
    const target = m[2]!.trim();

    if (kind === 'V') {
      if (target.includes('.')) {
        const resolved = q.resolvePin(target);
        const net = q.netOfPin(resolved.key);
        if (!net) throw new CadError('invalid', `pin ${target} is unconnected`);
        pinProbes.push({ probeKey: `V(${target})`, netName: net.name });
      } else {
        const net = q.requireNet(target);
        if (`V(${target})` !== `V(${net.name})`) {
          netProbes.push({ probeKey: `V(${target})`, netName: net.name });
        }
      }
      continue;
    }

    if (target.includes('.')) {
      const resolved = q.resolvePin(target);
      if (!q.netOfPin(resolved.key)) throw new CadError('invalid', `pin ${target} is unconnected`);
      addSensePin(resolved.key, `I(${target})`);
      continue;
    }

    const comp = q.requireComponent(target);
    const part = q.part(comp);
    const anyConn = part.pins.some(p => q.netOfPin(pinKey(comp.id, p.id)) !== undefined);
    if (!anyConn) {
      zeroCurrentProbes.push(`I(${comp.ref})`);
      continue;
    }
    const spiceRef = part.sim?.find(s => s.kind === 'spice')?.ref;
    if (spiceRef === 'V' || spiceRef === 'VSYM') continue;
    if (part.pins.length > 2 && spiceRef !== 'POT') {
      throw new CadError(
        'invalid',
        `I(${comp.ref}) is ambiguous on ${part.pins.length}-pin part ${part.id}`,
        `specify a pin such as I(${comp.ref}.${part.pins[0]!.name})`,
      );
    }
    const firstPin =
      spiceRef === 'D1N4148' || spiceRef === 'DZ' || spiceRef === 'LED'
        ? findPin(part, ['A', 'anode', '+', '1'], 0)
        : spiceRef === 'C'
          ? findPin(part, ['1', '+', 'pos'], 0)
          : findPin(part, ['1'], 0);
    addSensePin(pinKey(comp.id, firstPin.id), `I(${comp.ref})`);
  }

  const usedRefsLower = new Set<string>();
  const sourceMap = new Map<string, string>();
  const senseMap = new Map<string, string[]>();
  const modelKeys = new Set<string>();
  const zeners = new Map<string, number>();
  const lines: string[] = [];
  const acSourceId = opts.analysis?.kind === 'ac' ? pickAcSourceId(q, comps) : undefined;
  let hasReactiveOrOsc = false;

  const rawPinNode = (comp: Component, pin: PinDef): string => {
    const net = q.netOfPin(pinKey(comp.id, pin.id));
    if (net) return netToSpiceNode.get(net.id)!;
    return makeUniqueName(`nc_${comp.ref}_${pin.name}`, usedNodesLower, 'nc');
  };

  const pinNode = (comp: Component, pin: PinDef): string => {
    const base = rawPinNode(comp, pin);
    const key = pinKey(comp.id, pin.id);
    const probeKeys = sensePins.get(key);
    if (!probeKeys) return base;
    const senseDev = makeUniqueName(`Vsense_${comp.ref}_${pin.name}`, usedRefsLower, 'V');
    const senseNode = makeUniqueName(`isense_${comp.ref}_${pin.name}`, usedNodesLower, 'n');
    lines.push(`${senseDev} ${base} ${senseNode} DC 0`);
    senseMap.set(senseDev.toLowerCase(), probeKeys);
    return senseNode;
  };

  for (const comp of comps) {
    const part = q.part(comp);
    const spiceSim = part.sim?.find(s => s.kind === 'spice');
    if (!spiceSim) {
      if (part.category === 'board' || part.id === 'arduino_uno' || part.id.startsWith('breadboard_') || part.sim?.some(s => s.kind === 'logic' && s.ref === 'probe')) {
        continue;
      }
      lines.push(`* ${comp.ref}: no SPICE model (${part.id})`);
      continue;
    }

    const anyConn = part.pins.some(p => q.netOfPin(pinKey(comp.id, p.id)) !== undefined);
    if (!anyConn) {
      lines.push(`* ${comp.ref}: unconnected`);
      continue;
    }

    const ref = spiceSim.ref;
    switch (ref) {
      case 'R': {
        const r = parseNumberProp(comp, part, 'resistance', true);
        const n1 = pinNode(comp, findPin(part, ['1'], 0));
        const n2 = pinNode(comp, findPin(part, ['2'], 1));
        const name = makeUniqueName(comp.ref, usedRefsLower, 'R');
        lines.push(`${name} ${n1} ${n2} ${r}`);
        break;
      }
      case 'POT': {
        const rTotal = parseNumberProp(comp, part, 'resistance', true);
        const pos = parseNumberProp(comp, part, 'position');
        if (pos < 0 || pos > 1) throw new CadError('invalid', `${comp.ref}: position must be in 0..1 (got ${pos})`);
        const r1w = Math.max(MIN_POT_R, pos * rTotal);
        const rw3 = Math.max(MIN_POT_R, (1 - pos) * rTotal);
        const n1 = pinNode(comp, findPin(part, ['1'], 0));
        const nW = pinNode(comp, findPin(part, ['W', '2'], 1));
        const n3 = pinNode(comp, findPin(part, ['3'], 2));
        lines.push(`${makeUniqueName(`${comp.ref}__1W`, usedRefsLower, 'R')} ${n1} ${nW} ${r1w}`);
        lines.push(`${makeUniqueName(`${comp.ref}__W3`, usedRefsLower, 'R')} ${nW} ${n3} ${rw3}`);
        break;
      }
      case 'C': {
        hasReactiveOrOsc = true;
        const c = parseNumberProp(comp, part, 'capacitance', true);
        const n1 = pinNode(comp, findPin(part, ['1', '+', 'pos'], 0));
        const n2 = pinNode(comp, findPin(part, ['2', '-', 'neg'], 1));
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'C')} ${n1} ${n2} ${c}`);
        break;
      }
      case 'L': {
        hasReactiveOrOsc = true;
        const l = parseNumberProp(comp, part, 'inductance', true);
        const n1 = pinNode(comp, findPin(part, ['1'], 0));
        const n2 = pinNode(comp, findPin(part, ['2'], 1));
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'L')} ${n1} ${n2} ${l}`);
        break;
      }
      case 'V': {
        const v = parseNumberProp(comp, part, 'voltage');
        const np = pinNode(comp, findPin(part, ['+', 'pos', '1'], 0));
        const nn = pinNode(comp, findPin(part, ['-', 'neg', '2'], 1));
        const name = makeUniqueName(comp.ref, usedRefsLower, 'V');
        sourceMap.set(name.toLowerCase(), comp.ref);
        lines.push(`${name} ${np} ${nn} DC ${v}${acSourceId === comp.id ? ' AC 1' : ''}`);
        break;
      }
      case 'VSYM': {
        const v = parseNumberProp(comp, part, 'voltage');
        const nv = pinNode(comp, findPin(part, ['VCC', '1'], 0));
        const name = makeUniqueName(comp.ref, usedRefsLower, 'V');
        sourceMap.set(name.toLowerCase(), comp.ref);
        lines.push(`${name} ${nv} 0 DC ${v}${acSourceId === comp.id ? ' AC 1' : ''}`);
        break;
      }
      case 'GND': {
        const ng = pinNode(comp, findPin(part, ['GND', '1'], 0));
        if (ng !== '0') {
          const name = makeUniqueName(comp.ref, usedRefsLower, 'V');
          sourceMap.set(name.toLowerCase(), comp.ref);
          lines.push(`${name} ${ng} 0 DC 0`);
        }
        break;
      }
      case 'SW': {
        const state = (comp.props.state ?? part.props?.state?.default ?? 'open').toLowerCase();
        const r = state === 'closed' || state === 'pressed' ? SWITCH_R_ON : SWITCH_R_OFF;
        const n1 = pinNode(comp, findPin(part, ['1'], 0));
        const n2 = pinNode(comp, findPin(part, ['2'], 1));
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'R')} ${n1} ${n2} ${r}`);
        break;
      }
      case 'D1N4148': {
        const na = pinNode(comp, findPin(part, ['A', 'anode', '+', '1'], 0));
        const nk = pinNode(comp, findPin(part, ['K', 'cathode', '-', '2'], 1));
        modelKeys.add('D1N4148');
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'D')} ${na} ${nk} D1N4148`);
        break;
      }
      case 'DZ': {
        const vz = parseNumberProp(comp, part, 'voltage', true);
        const na = pinNode(comp, findPin(part, ['A', 'anode', '+', '1'], 0));
        const nk = pinNode(comp, findPin(part, ['K', 'cathode', '-', '2'], 1));
        const mname = zenerModelName(vz);
        modelKeys.add(mname);
        zeners.set(mname, vz);
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'D')} ${na} ${nk} ${mname}`);
        break;
      }
      case 'LED': {
        const color = (comp.props.color ?? part.props?.color?.default ?? 'red').toLowerCase() as LedColor;
        if (!Object.hasOwn(LED_MODELS, color)) {
          throw new CadError('invalid', `${comp.ref}: unsupported LED color "${color}"`, `supported: ${Object.keys(LED_MODELS).join(' ')}`);
        }
        const na = pinNode(comp, findPin(part, ['A', 'anode', '+', '1'], 0));
        const nk = pinNode(comp, findPin(part, ['K', 'cathode', '-', '2'], 1));
        const mname = ledModelName(color);
        modelKeys.add(mname);
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'D')} ${na} ${nk} ${mname}`);
        break;
      }
      case 'Q2N3904':
      case 'Q2N3906': {
        const nc = pinNode(comp, findPin(part, ['C', 'collector', '3'], 2));
        const nb = pinNode(comp, findPin(part, ['B', 'base', '2'], 1));
        const ne = pinNode(comp, findPin(part, ['E', 'emitter', '1'], 0));
        modelKeys.add(ref);
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'Q')} ${nc} ${nb} ${ne} ${ref}`);
        break;
      }
      case 'M2N7000': {
        const nd = pinNode(comp, findPin(part, ['D', 'drain', '3'], 2));
        const ng = pinNode(comp, findPin(part, ['G', 'gate', '2'], 1));
        const ns = pinNode(comp, findPin(part, ['S', 'source', '1'], 0));
        modelKeys.add('M2N7000');
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'M')} ${nd} ${ng} ${ns} ${ns} M2N7000`);
        break;
      }
      case 'NE555': {
        hasReactiveOrOsc = true;
        const gnd = pinNode(comp, findPin(part, ['GND', '1'], 0));
        const trig = pinNode(comp, findPin(part, ['TRIG', '2'], 1));
        const out = pinNode(comp, findPin(part, ['OUT', '3'], 2));
        const reset = pinNode(comp, findPin(part, ['RESET', '4'], 3));
        const ctrl = pinNode(comp, findPin(part, ['CTRL', 'CONT', '5'], 4));
        const thr = pinNode(comp, findPin(part, ['THR', 'THRES', '6'], 5));
        const dis = pinNode(comp, findPin(part, ['DIS', 'DISCH', '7'], 6));
        const vcc = pinNode(comp, findPin(part, ['VCC', '8'], 7));
        modelKeys.add('NE555');
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'X')} ${gnd} ${trig} ${out} ${reset} ${ctrl} ${thr} ${dis} ${vcc} NE555`);
        break;
      }
      case 'LM358': {
        const out1 = pinNode(comp, findPin(part, ['1OUT', '1'], 0));
        const inm1 = pinNode(comp, findPin(part, ['1IN-', '2'], 1));
        const inp1 = pinNode(comp, findPin(part, ['1IN+', '3'], 2));
        const gnd = pinNode(comp, findPin(part, ['GND', 'V-', '4'], 3));
        const inp2 = pinNode(comp, findPin(part, ['2IN+', '5'], 4));
        const inm2 = pinNode(comp, findPin(part, ['2IN-', '6'], 5));
        const out2 = pinNode(comp, findPin(part, ['2OUT', '7'], 6));
        const vcc = pinNode(comp, findPin(part, ['VCC', 'V+', '8'], 7));
        modelKeys.add('LM358');
        lines.push(`${makeUniqueName(comp.ref, usedRefsLower, 'X')} ${out1} ${inm1} ${inp1} ${gnd} ${inp2} ${inm2} ${out2} ${vcc} LM358`);
        break;
      }
      default:
        throw new CadError('invalid', `${comp.ref}: unsupported SPICE model "${ref}" (part ${part.id})`);
    }
  }

  const title = (opts.title ?? 'CadLLM circuit').replace(/[\r\n]+/g, ' ').trim() || 'CadLLM circuit';
  const modelBlocks = emitModels(modelKeys, zeners);
  const sections = [title, ...lines, ...modelBlocks];
  if (opts.analysis) sections.push(formatAnalysisCard(opts.analysis, hasReactiveOrOsc));
  sections.push('.end');

  return {
    netlist: sections.join('\n'),
    refNetName: refNet.name,
    nodeMap,
    sourceMap,
    senseMap,
    pinProbes,
    netProbes,
    zeroCurrentProbes,
  };
}

/** Generate a SPICE netlist from a CadLLM circuit Query. */
export function toSpiceNetlist(q: Query, opts: SpiceNetlistOptions = {}): string {
  return buildSpiceCircuit(q, opts).netlist;
}
