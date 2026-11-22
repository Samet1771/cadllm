// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, pinKey, type Component, type Net, type PartDef, type Query } from '@cadllm/core';
import type { PlaceOptions, PlaceResult } from '../types.ts';
import { isGroundNet, isPowerNet, resolveSchFamily } from './nets.ts';
import { boxesOverlap, dirDelta, formatSchPlace, parseSchPlace } from './place.ts';
import { buildSymbol } from './symbols/index.ts';
import type { GridBox, PlacedSymbol, SchPlace } from './types.ts';

const SHUNT_FAMILIES = new Set(['resistor', 'capacitor', 'capacitor_pol', 'inductor', 'diode', 'zener']);
const SOURCE_FAMILIES = new Set(['battery', 'vsource']);
const INPUT_FAMILIES = new Set(['switch', 'button', 'pot']);
const OUTPUT_FAMILIES = new Set(['led', 'buzzer', 'probe']);

function padBox(b: GridBox, mx: number, my: number): GridBox {
  return { minX: b.minX - mx, minY: b.minY - my, maxX: b.maxX + mx, maxY: b.maxY + my };
}

function findFreeSpot(
  q: Query,
  comp: Component,
  part: PartDef,
  ideal: SchPlace,
  occupied: GridBox[],
  marginX = 2,
  marginY = 2,
): { place: SchPlace; sym: PlacedSymbol } {
  // Search outward vertically first (0, +2, -2, +4, -4, ...), then slight x shifts.
  const dyOffsets = [0];
  for (let d = 2; d <= 40; d += 2) {
    dyOffsets.push(d, -d);
  }
  const dxOffsets = [0, 3, -3, 6, -6, 10, -10];

  for (const dx of dxOffsets) {
    for (const dy of dyOffsets) {
      const candidate: SchPlace = { ...ideal, x: ideal.x + dx, y: ideal.y + dy };
      const sym = buildSymbol(q, comp, part, candidate);
      const padded = padBox(sym.bodyBox, marginX, marginY);
      if (!occupied.some(ob => boxesOverlap(padded, ob))) {
        return { place: candidate, sym };
      }
    }
  }
  const sym = buildSymbol(q, comp, part, ideal);
  return { place: ideal, sym };
}

interface ShuntInfo {
  comp: Component;
  part: PartDef;
  signalNet: Net;
  powerNet: Net;
  isPullDown: boolean;
  rot: 0 | 90 | 180 | 270;
}

function detectShunt(q: Query, comp: Component, part: PartDef, family: string): ShuntInfo | undefined {
  if (!SHUNT_FAMILIES.has(family) || part.pins.length !== 2) return undefined;
  const p1 = part.pins[0]!;
  const p2 = part.pins[1]!;
  const n1 = q.netOfPin(pinKey(comp.id, p1.id));
  const n2 = q.netOfPin(pinKey(comp.id, p2.id));
  if (!n1 || !n2 || n1.id === n2.id) return undefined;

  const pwr1 = isPowerNet(q, n1);
  const pwr2 = isPowerNet(q, n2);
  if (pwr1 === pwr2) return undefined; // either both power (decoupling) or both signal (series)

  const powerNet = pwr1 ? n1 : n2;
  const signalNet = pwr1 ? n2 : n1;
  const powerPinIdx = pwr1 ? 0 : 1; // 0 is local (-2,0), 1 is local (+2,0)

  // Only treat as a shunt if the signal net has >= 3 pins OR connects to an IC/input/transistor.
  const otherCompsOnSignal = signalNet.pins
    .map(k => k.split(':')[0]!)
    .filter(cid => cid !== comp.id)
    .map(cid => q.circuit.components[cid])
    .filter((c): c is Component => !!c);

  if (otherCompsOnSignal.length === 0) return undefined;
  const hasLogicOrInput = otherCompsOnSignal.some(c => {
    const p = q.parts.get(c.part);
    if (!p) return false;
    const fam = resolveSchFamily(p);
    return fam === 'ic' || fam === 'board' || INPUT_FAMILIES.has(fam) || fam === 'npn' || fam === 'pnp' || fam === 'nmos';
  });
  if (signalNet.pins.length < 3 && !hasLogicOrInput) return undefined;

  const isPullDown = isGroundNet(q, powerNet);
  // Local pin 0 is (-2,0), pin 1 is (+2,0).
  // rot=90 maps (-2,0)->(0,-2) UP, (+2,0)->(0,+2) DOWN.
  // rot=270 maps (-2,0)->(0,+2) DOWN, (+2,0)->(0,-2) UP.
  let rot: 90 | 270;
  if (isPullDown) {
    rot = powerPinIdx === 1 ? 90 : 270;
  } else {
    rot = powerPinIdx === 0 ? 90 : 270;
  }

  return { comp, part, signalNet, powerNet, isPullDown, rot };
}

export function autoPlaceSchematic(q: Query, opts: PlaceOptions = {}): PlaceResult {
  const refFilter = opts.refs ? new Set(opts.refs.map(r => r.toUpperCase())) : undefined;
  const allComps = q.components();

  const fixedSymbols: PlacedSymbol[] = [];
  const mainTargets: { comp: Component; part: PartDef; family: string }[] = [];
  const powerTargets: { comp: Component; part: PartDef; family: string }[] = [];

  for (const comp of allComps) {
    const part = q.parts.get(comp.part);
    if (!part) continue;
    const family = resolveSchFamily(part);
    if (family === 'none') continue;

    const rawPlace = comp.place['sch'];
    const parsed = rawPlace ? parseSchPlace(rawPlace) : undefined;
    const wantPlace = (!refFilter || refFilter.has(comp.ref.toUpperCase())) && (opts.all || !parsed);

    if (!wantPlace) {
      if (parsed) fixedSymbols.push(buildSymbol(q, comp, part, parsed));
      continue;
    }

    if (family === 'vcc' || family === 'gnd') {
      powerTargets.push({ comp, part, family });
    } else {
      mainTargets.push({ comp, part, family });
    }
  }

  const place: Record<string, string> = {};
  const notes: string[] = [];

  if (mainTargets.length === 0 && powerTargets.length === 0) {
    return { place, notes };
  }

  const occupied: GridBox[] = fixedSymbols.map(s => padBox(s.bodyBox, 2, 2));
  const placedMap = new Map<string, PlacedSymbol>();
  for (const s of fixedSymbols) placedMap.set(s.comp.id, s);

  // Detect shunt components (pull-ups, pull-downs).
  const shunts = new Map<string, ShuntInfo>();
  const flowTargets: { comp: Component; part: PartDef; family: string }[] = [];
  for (const t of mainTargets) {
    const sh = detectShunt(q, t.comp, t.part, t.family);
    if (sh) shunts.set(t.comp.id, sh);
    else flowTargets.push(t);
  }

  // Build directed signal graph over flowTargets for layering.
  const flowSet = new Set(flowTargets.map(t => t.comp.id));
  const edges = new Map<string, Set<string>>();
  for (const id of flowSet) edges.set(id, new Set());

  const hasSources = flowTargets.some(t => SOURCE_FAMILIES.has(t.family));
  const layer = new Map<string, number>();

  for (const t of flowTargets) {
    if (SOURCE_FAMILIES.has(t.family)) layer.set(t.comp.id, 0);
    else if (INPUT_FAMILIES.has(t.family)) layer.set(t.comp.id, hasSources ? 1 : 0);
    else layer.set(t.comp.id, hasSources ? 1 : 0);
  }

  // Determine directed edges across non-power nets.
  const preferredRot = new Map<string, 0 | 90 | 180 | 270>();
  const nonPowerNetMembers: { net: Net; members: { comp: Component; part: PartDef; pin: PartDef['pins'][number]; fam: string }[] }[] = [];

  for (const net of q.nets()) {
    if (isPowerNet(q, net)) continue;
    const members = net.pins
      .map(k => {
        const [cid, pid] = k.split(':') as [string, string];
        const comp = q.circuit.components[cid];
        const part = comp ? q.parts.get(comp.part) : undefined;
        const pin = part?.pins.find(p => p.id === pid);
        const fam = part ? resolveSchFamily(part) : 'ic';
        return comp && part && pin && flowSet.has(cid) ? { comp, part, pin, fam } : undefined;
      })
      .filter((m): m is NonNullable<typeof m> => !!m);

    if (members.length < 2) continue;
    nonPowerNetMembers.push({ net, members });

    // Identify drivers on this net.
    let drivers = members.filter(m =>
      m.pin.type === 'output' || m.pin.type === 'tristate' || m.pin.type === 'open_collector' || m.pin.type === 'power_out',
    );
    if (drivers.length === 0) {
      drivers = members.filter(m => INPUT_FAMILIES.has(m.fam) || SOURCE_FAMILIES.has(m.fam));
    }
    if (drivers.length === 0) {
      drivers = members.filter(m => {
        if (OUTPUT_FAMILIES.has(m.fam)) return false;
        const otherPins = m.part.pins.filter(p => p.id !== m.pin.id);
        return otherPins.some(op => {
          const onet = q.netOfPin(pinKey(m.comp.id, op.id));
          return onet && isPowerNet(q, onet) && !isGroundNet(q, onet);
        });
      });
    }
    if (drivers.length === 0 && members.some(m => OUTPUT_FAMILIES.has(m.fam))) {
      drivers = members.filter(m => !OUTPUT_FAMILIES.has(m.fam));
    }

    for (const d of drivers) {
      for (const m of members) {
        if (m.comp.id === d.comp.id) continue;
        edges.get(d.comp.id)!.add(m.comp.id);
      }
    }

    // Orient 2-pin parts left->right along signal flow.
    for (const m of members) {
      if (m.part.pins.length === 2 && !SOURCE_FAMILIES.has(m.fam)) {
        const isDriver = drivers.some(d => d.comp.id === m.comp.id);
        const pinIdx = m.part.pins.findIndex(p => p.id === m.pin.id);
        if (!isDriver && drivers.length > 0) {
          if (!preferredRot.has(m.comp.id)) preferredRot.set(m.comp.id, pinIdx === 1 ? 180 : 0);
        } else if (isDriver) {
          if (!preferredRot.has(m.comp.id)) preferredRot.set(m.comp.id, pinIdx === 0 ? 180 : 0);
        }
      }
    }
  }

  // Propagate direction through series 2-pin passives (e.g. U1 -> R1 -> D1).
  const hasIncoming = (id: string): boolean => {
    for (const [, vs] of edges) if (vs.has(id)) return true;
    return false;
  };
  for (let pass = 0; pass < flowTargets.length; pass++) {
    let added = false;
    for (const { members } of nonPowerNetMembers) {
      const activeDrivers = members.filter(m => hasIncoming(m.comp.id) && !OUTPUT_FAMILIES.has(m.fam));
      if (activeDrivers.length === 0) continue;
      for (const d of activeDrivers) {
        for (const m of members) {
          if (m.comp.id === d.comp.id) continue;
          if (SOURCE_FAMILIES.has(m.fam) || INPUT_FAMILIES.has(m.fam)) continue;
          if (edges.get(m.comp.id)!.has(d.comp.id)) continue;
          if (!edges.get(d.comp.id)!.has(m.comp.id)) {
            edges.get(d.comp.id)!.add(m.comp.id);
            added = true;
            if (m.part.pins.length === 2 && !preferredRot.has(m.comp.id)) {
              const pinIdx = m.part.pins.findIndex(p => p.id === m.pin.id);
              preferredRot.set(m.comp.id, pinIdx === 1 ? 180 : 0);
            }
          }
        }
      }
    }
    if (!added) break;
  }

  // Also orient 2-pin parts connected to VCC/GND directly.
  for (const t of flowTargets) {
    if (t.part.pins.length === 2 && !SOURCE_FAMILIES.has(t.family) && !preferredRot.has(t.comp.id)) {
      const p0Net = q.netOfPin(pinKey(t.comp.id, t.part.pins[0]!.id));
      const p1Net = q.netOfPin(pinKey(t.comp.id, t.part.pins[1]!.id));
      if (p0Net && isGroundNet(q, p0Net)) preferredRot.set(t.comp.id, 180);
      else if (p1Net && isPowerNet(q, p1Net) && !isGroundNet(q, p1Net)) preferredRot.set(t.comp.id, 180);
      else preferredRot.set(t.comp.id, 0);
    }
  }

  // Relax layers along directed edges (with cycle cap).
  const maxLayerCap = flowTargets.length + 2;
  for (let iter = 0; iter < flowTargets.length; iter++) {
    let changed = false;
    for (const [u, vs] of edges) {
      const lu = layer.get(u) ?? 0;
      for (const v of vs) {
        const lv = layer.get(v) ?? 0;
        if (lu + 1 > lv && lu + 1 <= maxLayerCap) {
          layer.set(v, lu + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Push output loads to at least max upstream + 1, and decoupling caps (both pins power) near layer 0/1.
  for (const t of flowTargets) {
    if (OUTPUT_FAMILIES.has(t.family)) {
      const cur = layer.get(t.comp.id) ?? 0;
      if (cur === 0 && flowTargets.length > 1) layer.set(t.comp.id, 1);
    }
  }

  // Compact layer numbers to 0..K-1.
  const usedLayers = [...new Set(flowTargets.map(t => layer.get(t.comp.id) ?? 0))].sort((a, b) => a - b);
  const layerMap = new Map<number, number>(usedLayers.map((l, idx) => [l, idx]));
  const layerBuckets: { comp: Component; part: PartDef; family: string }[][] = Array.from(
    { length: usedLayers.length },
    () => [],
  );
  for (const t of flowTargets) {
    const li = layerMap.get(layer.get(t.comp.id) ?? 0)!;
    layerBuckets[li]!.push(t);
  }
  for (const b of layerBuckets) b.sort((a, c) => naturalCompare(a.comp.ref, c.comp.ref));

  // Measure column widths and assign X centers.
  const colWidths = layerBuckets.map(bucket => {
    let maxW = 4;
    for (const t of bucket) {
      const rot = preferredRot.get(t.comp.id) ?? 0;
      const sym = buildSymbol(q, t.comp, t.part, { x: 0, y: 0, rot, mirror: false });
      maxW = Math.max(maxW, sym.fullBox.maxX - sym.fullBox.minX);
    }
    return Math.ceil(maxW);
  });

  // Check if any layer between i and i+1 holds a shunt resistor/capacitor; add extra X gap if so.
  const colGap = (i: number): number => {
    const hasShuntBetween = [...shunts.values()].some(sh => {
      const cids = sh.signalNet.pins.map(k => k.split(':')[0]!);
      const ls = cids.filter(id => flowSet.has(id)).map(id => layerMap.get(layer.get(id) ?? 0)!);
      return ls.includes(i) && ls.includes(i + 1);
    });
    return hasShuntBetween ? 8 : 6;
  };

  const colX: number[] = [];
  let curX = 4;
  for (let i = 0; i < colWidths.length; i++) {
    const half = Math.ceil(colWidths[i]! / 2);
    curX += half;
    colX.push(curX);
    curX += half + (i < colWidths.length - 1 ? colGap(i) : 0);
  }

  // Determine placement order: place IC/board layers first so adjacent layers align to exact IC pin Ys.
  const icLayerIdx = layerBuckets.findIndex(b => b.some(t => t.family === 'ic' || t.family === 'board'));
  const layerOrder: number[] = [];
  if (icLayerIdx >= 0) {
    layerOrder.push(icLayerIdx);
    for (let offset = 1; offset < layerBuckets.length; offset++) {
      if (icLayerIdx + offset < layerBuckets.length) layerOrder.push(icLayerIdx + offset);
      if (icLayerIdx - offset >= 0) layerOrder.push(icLayerIdx - offset);
    }
  } else {
    for (let i = 0; i < layerBuckets.length; i++) layerOrder.push(i);
  }

  for (const li of layerOrder) {
    const bucket = layerBuckets[li]!;
    const cx = colX[li]!;

    // Compute desired Y for each component from pins connected to already-placed components.
    const scored = bucket.map(t => {
      const rot = preferredRot.get(t.comp.id) ?? 0;
      const probeSym = buildSymbol(q, t.comp, t.part, { x: cx, y: 0, rot, mirror: false });
      const targetYs: number[] = [];
      for (const pp of probeSym.pins) {
        const net = q.netOfPin(pp.key);
        if (!net || isPowerNet(q, net)) continue;
        for (const ok of net.pins) {
          const [ocid] = ok.split(':') as [string, string];
          if (ocid === t.comp.id) continue;
          const otherSym = placedMap.get(ocid);
          if (!otherSym) continue;
          const otherPin = otherSym.pins.find(op => op.key === ok);
          if (otherPin) {
            // Adjust component origin Y so pp aligns horizontally with otherPin.gy.
            const localPinDy = pp.gy;
            targetYs.push(otherPin.gy - localPinDy);
          }
        }
      }
      const idealY = targetYs.length > 0
        ? Math.round(targetYs.reduce((a, b) => a + b, 0) / targetYs.length)
        : 0;
      return { ...t, rot, idealY };
    });

    scored.sort((a, b) => a.idealY - b.idealY || naturalCompare(a.comp.ref, b.comp.ref));

    for (const item of scored) {
      const ideal: SchPlace = { x: cx, y: item.idealY, rot: item.rot, mirror: false };
      const { place: p, sym } = findFreeSpot(q, item.comp, item.part, ideal, occupied, 2, 2);
      placedMap.set(item.comp.id, sym);
      occupied.push(padBox(sym.bodyBox, 2, 2));
      place[item.comp.ref] = formatSchPlace(p);
    }
  }

  // Place shunt components (pull-up / pull-down) near the midpoint of their signal net's placed pins.
  const shuntList = [...shunts.values()].sort((a, b) => naturalCompare(a.comp.ref, b.comp.ref));
  for (const sh of shuntList) {
    const netPins: { gx: number; gy: number }[] = [];
    for (const k of sh.signalNet.pins) {
      const [cid] = k.split(':') as [string, string];
      if (cid === sh.comp.id) continue;
      const sym = placedMap.get(cid);
      const pp = sym?.pins.find(p => p.key === k);
      if (pp) netPins.push({ gx: pp.gx, gy: pp.gy });
    }
    const avgX = netPins.length > 0
      ? Math.round(netPins.reduce((s, p) => s + p.gx, 0) / netPins.length)
      : 10;
    const avgY = netPins.length > 0
      ? Math.round(netPins.reduce((s, p) => s + p.gy, 0) / netPins.length)
      : 0;
    const idealY = sh.isPullDown ? avgY + 3 : avgY - 3;
    const ideal: SchPlace = { x: avgX, y: idealY, rot: sh.rot, mirror: false };
    const { place: p, sym } = findFreeSpot(q, sh.comp, sh.part, ideal, occupied, 1, 2);
    placedMap.set(sh.comp.id, sym);
    occupied.push(padBox(sym.bodyBox, 1, 2));
    place[sh.comp.ref] = formatSchPlace(p);
  }

  // Place explicit vcc/gnd power symbols near their connected pins.
  powerTargets.sort((a, b) => naturalCompare(a.comp.ref, b.comp.ref));
  for (const pt of powerTargets) {
    const p0 = pt.part.pins[0];
    const net = p0 ? q.netOfPin(pinKey(pt.comp.id, p0.id)) : undefined;
    let idealX = 0;
    let idealY = pt.family === 'vcc' ? -4 : 4;

    if (net) {
      const candidates: { gx: number; gy: number; dx: number; dy: number }[] = [];
      for (const k of net.pins) {
        const [cid] = k.split(':') as [string, string];
        if (cid === pt.comp.id) continue;
        const sym = placedMap.get(cid);
        const pp = sym?.pins.find(p => p.key === k);
        if (pp) {
          const d = dirDelta(pp.dir);
          candidates.push({ gx: pp.gx, gy: pp.gy, dx: d.x, dy: d.y });
        }
      }
      if (candidates.length > 0) {
        const anchor = candidates[0]!;
        idealX = anchor.gx + anchor.dx * 2;
        idealY = anchor.gy + (pt.family === 'vcc' ? -2 : 2);
      }
    }

    const ideal: SchPlace = { x: idealX, y: idealY, rot: 0, mirror: false };
    const { place: p, sym } = findFreeSpot(q, pt.comp, pt.part, ideal, occupied, 1, 1);
    placedMap.set(pt.comp.id, sym);
    occupied.push(padBox(sym.bodyBox, 1, 1));
    place[pt.comp.ref] = formatSchPlace(p);
  }

  notes.push(`placed ${Object.keys(place).length} component${Object.keys(place).length === 1 ? '' : 's'} in schematic`);
  return { place, notes };
}
