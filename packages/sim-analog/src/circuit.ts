// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, naturalCompare, parseSI, pinKey, type Component, type Net, type PartDef, type PinDef, type Query } from '@cadllm/core';
import { solveNetlist } from './solver.ts';
import {
  DIODE_1N4148,
  LED_MODELS,
  MIN_POT_R,
  R_OUT,
  SWITCH_R_OFF,
  SWITCH_R_ON,
  type LedColor,
  type LogicLevel,
  type NetlistElement,
  type OpOptions,
  type OpResult,
} from './types.ts';

const resultQueryMap = new WeakMap<OpResult, Query>();

const SI_PREFIXES: ReadonlyArray<readonly [number, string]> = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

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

function lookupCaseInsensitive<T>(map: Record<string, T>, key: string): T | undefined {
  if (Object.hasOwn(map, key)) return map[key];
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

function findNamedPin(part: PartDef, name: string): PinDef | undefined {
  const upper = name.toUpperCase();
  return part.pins.find(
    p => p.name.toUpperCase() === upper || p.aliases?.some(a => a.toUpperCase() === upper),
  );
}

function parseNumberProp(comp: Component, part: PartDef, key: string): number {
  const raw = comp.props[key] ?? part.props?.[key]?.default;
  if (raw === undefined) {
    throw new CadError('invalid', `${comp.ref}: missing required property "${key}"`);
  }
  const val = parseSI(raw);
  if (val === undefined || !Number.isFinite(val)) {
    throw new CadError('invalid', `${comp.ref}: invalid ${key} value "${raw}"`);
  }
  return val;
}

function pickReferenceNet(q: Query, comps: Component[]): Net {
  const nets = q.nets();
  const gndNets = new Set<Net>();
  for (const comp of comps) {
    const part = q.part(comp);
    const spiceRef = part.sim?.find(s => s.kind === 'spice')?.ref;
    if (spiceRef !== 'GND') continue;
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
    const spiceRef = part.sim?.find(s => s.kind === 'spice')?.ref;
    if (spiceRef !== 'V') continue;
    const negPin = findPin(part, ['-', 'neg', '2'], 1);
    const net = q.netOfPin(pinKey(comp.id, negPin.id));
    if (net) return net;
  }

  if (nets.length === 0) {
    throw new CadError('invalid', 'circuit has no nets or reference node');
  }
  throw new CadError('invalid', 'no reference node: add a gnd_symbol, a GND net, or a voltage source');
}

/**
 * Compute the DC operating point of a circuit using Modified Nodal Analysis (MNA).
 * Reference node priority: net with gnd_symbol -> net named GND -> '-' pin of first V source.
 */
export function operatingPoint(q: Query, opts: OpOptions = {}): OpResult {
  const comps = q.components();
  const nets = q.nets();
  const refNet = pickReferenceNet(q, comps);

  const netToId = new Map<string, number>([[refNet.id, 0]]);
  const nodeNames: Record<number, string> = { 0: refNet.name };
  let nextNodeId = 1;
  for (const net of nets) {
    if (net.id === refNet.id) continue;
    netToId.set(net.id, nextNodeId);
    nodeNames[nextNodeId] = net.name;
    nextNodeId++;
  }

  const warnings: string[] = [];
  const elements: NetlistElement[] = [];
  const pots: Array<{ ref: string; n1: number; nW: number; n3: number; r1w: number; rw3: number }> = [];
  const unconnectedRefs: string[] = [];
  const undrivenDrivers: Record<number, string[]> = {};

  const recordUndriven = (netIdNum: number, pinLabel: string) => {
    (undrivenDrivers[netIdNum] ??= []).push(pinLabel);
  };

  const pinNodeId = (comp: Component, pin: PinDef, missingList: string[]): number => {
    const net = q.netOfPin(pinKey(comp.id, pin.id));
    if (net) return netToId.get(net.id)!;
    const id = nextNodeId++;
    const label = `${comp.ref}.${pin.name}`;
    nodeNames[id] = label;
    missingList.push(label);
    return id;
  };

  for (const comp of comps) {
    const part = q.part(comp);
    const spiceSim = part.sim?.find(s => s.kind === 'spice');
    const logicSim = part.sim?.find(s => s.kind === 'logic');

    if (!spiceSim) {
      if (logicSim) {
        if (logicSim.ref === 'probe') continue;

        const vccPin = findNamedPin(part, 'VCC');
        const gndPin = findNamedPin(part, 'GND');
        const vccNet = vccPin ? q.netOfPin(pinKey(comp.id, vccPin.id)) : undefined;
        const gndNet = gndPin ? q.netOfPin(pinKey(comp.id, gndPin.id)) : undefined;
        const connectedOutputs = part.pins
          .filter(p => p.type === 'output' || p.type === 'tristate')
          .map(p => ({ pin: p, net: q.netOfPin(pinKey(comp.id, p.id)) }))
          .filter((x): x is { pin: PinDef; net: Net } => x.net !== undefined);

        if (!vccNet || !gndNet) {
          warnings.push(`${comp.ref}: VCC/GND unconnected, outputs undriven`);
          for (const { pin, net } of connectedOutputs) {
            recordUndriven(netToId.get(net.id)!, `${comp.ref}.${pin.name}`);
          }
          continue;
        }

        const vccNode = netToId.get(vccNet.id)!;
        const gndNode = netToId.get(gndNet.id)!;
        let hasUndriven = false;

        for (const { pin, net } of connectedOutputs) {
          const outNode = netToId.get(net.id)!;
          const level: LogicLevel | undefined = opts.logic ? lookupCaseInsensitive(opts.logic, net.name) : undefined;
          if (level === '1') {
            elements.push({ kind: 'R', ref: `${comp.ref}.__out_${pin.id}`, a: outNode, b: vccNode, resistance: R_OUT });
          } else if (level === '0') {
            elements.push({ kind: 'R', ref: `${comp.ref}.__out_${pin.id}`, a: outNode, b: gndNode, resistance: R_OUT });
          } else {
            hasUndriven = true;
            recordUndriven(outNode, `${comp.ref}.${pin.name}`);
          }
        }

        if (hasUndriven) {
          warnings.push(
            !opts.logic
              ? `${comp.ref}: outputs undriven (no logic levels given)`
              : `${comp.ref}: outputs undriven (X/Z or missing logic levels)`,
          );
        }
        continue;
      }

      if (part.category === 'board' || part.id === 'arduino_uno' || part.id.startsWith('breadboard_')) {
        continue;
      }
      warnings.push(`${comp.ref}: no analog model, treated as open`);
      continue;
    }

    const spiceRef = spiceSim.ref;
    const supported =
      spiceRef === 'R' || spiceRef === 'POT' || spiceRef === 'V' || spiceRef === 'VSYM' ||
      spiceRef === 'GND' || spiceRef === 'SW' || spiceRef === 'C' || spiceRef === 'L' ||
      spiceRef === 'D1N4148' || spiceRef === 'DZ' || spiceRef === 'LED';
    if (!supported) {
      throw new CadError(
        'invalid',
        `${comp.ref}: unsupported analog SPICE model "${spiceRef}" (part ${part.id})`,
        'DC solver supports R, POT, V, VSYM, GND, SW, C, L, D1N4148, DZ, LED',
      );
    }

    // Check if ALL pins of this component are unconnected; if so, warn and skip stamping.
    const anyConnected = part.pins.some(p => q.netOfPin(pinKey(comp.id, p.id)) !== undefined);
    if (!anyConnected) {
      unconnectedRefs.push(comp.ref);
      warnings.push(`${comp.ref} is completely unconnected`);
      continue;
    }

    const openPins: string[] = [];

    switch (spiceRef) {
      case 'R': {
        const p1 = findPin(part, ['1'], 0);
        const p2 = findPin(part, ['2'], 1);
        const r = parseNumberProp(comp, part, 'resistance');
        elements.push({ kind: 'R', ref: comp.ref, a: pinNodeId(comp, p1, openPins), b: pinNodeId(comp, p2, openPins), resistance: r });
        break;
      }
      case 'POT': {
        const p1 = findPin(part, ['1'], 0);
        const pW = findPin(part, ['W', '2'], 1);
        const p3 = findPin(part, ['3'], 2);
        const rTotal = parseNumberProp(comp, part, 'resistance');
        if (rTotal <= 0) throw new CadError('invalid', `${comp.ref}: resistance must be > 0 (got ${rTotal})`);
        const pos = parseNumberProp(comp, part, 'position');
        if (pos < 0 || pos > 1) throw new CadError('invalid', `${comp.ref}: position must be in 0..1 (got ${pos})`);
        const r1w = Math.max(MIN_POT_R, pos * rTotal);
        const rw3 = Math.max(MIN_POT_R, (1 - pos) * rTotal);
        const n1 = pinNodeId(comp, p1, openPins);
        const nW = pinNodeId(comp, pW, openPins);
        const n3 = pinNodeId(comp, p3, openPins);
        elements.push({ kind: 'R', ref: `${comp.ref}.__1W`, a: n1, b: nW, resistance: r1w });
        elements.push({ kind: 'R', ref: `${comp.ref}.__W3`, a: nW, b: n3, resistance: rw3 });
        pots.push({ ref: comp.ref, n1, nW, n3, r1w, rw3 });
        break;
      }
      case 'V': {
        const pPos = findPin(part, ['+', 'pos', '1'], 0);
        const pNeg = findPin(part, ['-', 'neg', '2'], 1);
        const v = parseNumberProp(comp, part, 'voltage');
        elements.push({ kind: 'V', ref: comp.ref, pos: pinNodeId(comp, pPos, openPins), neg: pinNodeId(comp, pNeg, openPins), voltage: v });
        break;
      }
      case 'VSYM': {
        const pVcc = findPin(part, ['VCC', '1'], 0);
        const v = parseNumberProp(comp, part, 'voltage');
        elements.push({ kind: 'V', ref: comp.ref, pos: pinNodeId(comp, pVcc, openPins), neg: 0, voltage: v });
        break;
      }
      case 'GND': {
        const pGnd = findPin(part, ['GND', '1'], 0);
        const nGnd = pinNodeId(comp, pGnd, openPins);
        if (nGnd !== 0) {
          elements.push({ kind: 'V', ref: comp.ref, pos: nGnd, neg: 0, voltage: 0 });
        }
        break;
      }
      case 'SW': {
        const p1 = findPin(part, ['1'], 0);
        const p2 = findPin(part, ['2'], 1);
        const state = (comp.props.state ?? part.props?.state?.default ?? 'open').toLowerCase();
        const r = state === 'closed' || state === 'pressed' ? SWITCH_R_ON : SWITCH_R_OFF;
        elements.push({ kind: 'R', ref: comp.ref, a: pinNodeId(comp, p1, openPins), b: pinNodeId(comp, p2, openPins), resistance: r });
        break;
      }
      case 'C': {
        const p1 = findPin(part, ['1', '+', 'pos'], 0);
        const p2 = findPin(part, ['2', '-', 'neg'], 1);
        const n1 = q.netOfPin(pinKey(comp.id, p1.id));
        const n2 = q.netOfPin(pinKey(comp.id, p2.id));
        if (!n1) openPins.push(`${comp.ref}.${p1.name}`);
        if (!n2) openPins.push(`${comp.ref}.${p2.name}`);
        elements.push({ kind: 'C', ref: comp.ref, a: n1 ? netToId.get(n1.id)! : 0, b: n2 ? netToId.get(n2.id)! : 0 });
        break;
      }
      case 'L': {
        const p1 = findPin(part, ['1'], 0);
        const p2 = findPin(part, ['2'], 1);
        elements.push({ kind: 'L', ref: comp.ref, a: pinNodeId(comp, p1, openPins), b: pinNodeId(comp, p2, openPins) });
        break;
      }
      case 'D1N4148': {
        const pA = findPin(part, ['A', 'anode', '+', '1'], 0);
        const pK = findPin(part, ['K', 'cathode', '-', '2'], 1);
        elements.push({ kind: 'D', ref: comp.ref, anode: pinNodeId(comp, pA, openPins), cathode: pinNodeId(comp, pK, openPins), model: DIODE_1N4148 });
        break;
      }
      case 'DZ': {
        const pA = findPin(part, ['A', 'anode', '+', '1'], 0);
        const pK = findPin(part, ['K', 'cathode', '-', '2'], 1);
        const vz = parseNumberProp(comp, part, 'voltage');
        elements.push({ kind: 'DZ', ref: comp.ref, anode: pinNodeId(comp, pA, openPins), cathode: pinNodeId(comp, pK, openPins), vz });
        break;
      }
      case 'LED': {
        const pA = findPin(part, ['A', 'anode', '+', '1'], 0);
        const pK = findPin(part, ['K', 'cathode', '-', '2'], 1);
        const color = (comp.props.color ?? part.props?.color?.default ?? 'red').toLowerCase() as LedColor;
        const model = LED_MODELS[color];
        if (!model) {
          throw new CadError('invalid', `${comp.ref}: unsupported LED color "${color}"`, `supported: ${Object.keys(LED_MODELS).join(' ')}`);
        }
        elements.push({ kind: 'D', ref: comp.ref, anode: pinNodeId(comp, pA, openPins), cathode: pinNodeId(comp, pK, openPins), model });
        break;
      }
      default:
        throw new CadError(
          'invalid',
          `${comp.ref}: unsupported analog SPICE model "${spiceRef}" (part ${part.id})`,
          'DC solver supports R, POT, V, VSYM, GND, SW, C, L, D1N4148, DZ, LED',
        );
    }

    if (openPins.length > 0) warnings.push(`${openPins.join(', ')} unconnected`);
  }

  const solved = solveNetlist(
    {
      reference: 0,
      nodeNames,
      ...(Object.keys(undrivenDrivers).length > 0 ? { undrivenDrivers } : {}),
      elements,
    },
    opts,
  );

  const v: Record<string, number> = {};
  for (const net of nets) {
    v[net.name] = solved.v[netToId.get(net.id)!]!;
  }

  const i: Record<string, number> = {};
  for (const [k, val] of Object.entries(solved.i)) {
    if (k.includes('.__')) continue;
    i[k] = val;
  }
  for (const pot of pots) {
    const v1 = solved.v[pot.n1]!;
    const vW = solved.v[pot.nW]!;
    const v3 = solved.v[pot.n3]!;
    i[pot.ref] = (v1 - vW) / pot.r1w;
    i[`${pot.ref}.W`] = (vW - v1) / pot.r1w + (vW - v3) / pot.rw3;
  }
  for (const ref of unconnectedRefs) i[ref] = 0;

  const out: OpResult = {
    v,
    i,
    converged: solved.converged,
    iterations: solved.iterations,
    reference: refNet.name,
    warnings: [...warnings, ...solved.warnings],
    ...(solved.reason !== undefined ? { reason: solved.reason } : {}),
  };
  resultQueryMap.set(out, q);
  return out;
}

/** Format a number with SI prefixes to 3 significant digits (token-cheap, parseSI-compatible). */
export function formatSI(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0 || Math.abs(value) < 1e-21) return '0';

  const abs = Math.abs(value);
  if (abs < 1e-15 || abs >= 1e12) {
    return Number(value.toPrecision(3)).toExponential();
  }

  for (let idx = 0; idx < SI_PREFIXES.length; idx++) {
    const [scale, prefix] = SI_PREFIXES[idx]!;
    if (abs >= scale * 0.9995 || idx === SI_PREFIXES.length - 1) {
      const scaled = Number((value / scale).toPrecision(3));
      if (Math.abs(scaled) >= 1000 && idx > 0) {
        const [upScale, upPrefix] = SI_PREFIXES[idx - 1]!;
        return `${Number((value / upScale).toPrecision(3))}${upPrefix}`;
      }
      return `${scaled}${prefix}`;
    }
  }
  return Number(value.toPrecision(3)).toString();
}

/**
 * Format operating-point results concisely with 3 significant digits and SI prefixes.
 * Accepts probes of the form `V(NET)`, `I(REF)`, and `V(REF.PIN)`.
 */
export function formatOp(r: OpResult, probes?: string[], q?: Query): string {
  const ctxQuery = q ?? resultQueryMap.get(r);
  const parts: string[] = [];

  if (!r.converged) {
    parts.push(`FAIL(${r.reason ?? 'did not converge'})`);
  }

  if (!probes || probes.length === 0) {
    for (const net of Object.keys(r.v).sort(naturalCompare)) {
      parts.push(`V(${net}) ${formatSI(r.v[net]!)}`);
    }
    for (const ref of Object.keys(r.i).sort(naturalCompare)) {
      parts.push(`I(${ref}) ${formatSI(r.i[ref]!)}`);
    }
    return parts.join('  ');
  }

  for (const rawProbe of probes) {
    const probe = rawProbe.trim();
    const m = probe.match(/^([VI])\(([^)]+)\)$/i);
    if (!m) {
      throw new CadError('invalid', `bad probe "${probe}"`, 'use V(NET), V(REF.PIN), or I(REF)');
    }
    const kind = m[1]!.toUpperCase();
    const target = m[2]!.trim();

    if (kind === 'V') {
      if (target.includes('.')) {
        let val = lookupCaseInsensitive(r.v, target);
        if (val === undefined) {
          if (!ctxQuery) {
            throw new CadError('invalid', `cannot resolve pin probe ${probe} without circuit Query`);
          }
          const resolved = ctxQuery.resolvePin(target);
          const net = ctxQuery.netOfPin(resolved.key);
          if (!net) {
            throw new CadError('invalid', `pin ${target} is unconnected`);
          }
          val = r.v[net.name];
        }
        if (val === undefined) throw new CadError('unknown_net', `no voltage result for ${probe}`);
        parts.push(`V(${target}) ${formatSI(val)}`);
      } else {
        const val = lookupCaseInsensitive(r.v, target);
        if (val === undefined) throw new CadError('unknown_net', `no net ${target} in operating point`);
        parts.push(`V(${target}) ${formatSI(val)}`);
      }
    } else {
      const val = lookupCaseInsensitive(r.i, target);
      if (val === undefined) throw new CadError('unknown_ref', `no component current ${target} in operating point`);
      parts.push(`I(${target}) ${formatSI(val)}`);
    }
  }

  return parts.join('  ');
}
