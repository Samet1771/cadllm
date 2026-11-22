// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, pinKey, type Component, type PartDef, type Query } from '@cadllm/core';
import { componentFootprintName, footprint, isPcbPart } from '../footprints/index.ts';
import type {
  DrcIssue,
  Footprint,
  PadInstance,
  PadLayers,
  PcbPlace,
  PcbPlaceOptions,
  PcbPlaceResult,
  PcbSide,
  Point,
} from '../types.ts';
import {
  autoBoardOutline,
  compCourtyardCorners,
  pointInPolygon,
  polyBounds,
  polyInsideBoard,
  polyIntersects,
  roundMm,
  transformPoint,
} from './geometry.ts';

const fmtMm = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Parse PCB placement string `x,y[,rot][,top|bottom]` (space or comma before side). */
export function parsePcbPlace(raw: string | undefined): PcbPlace | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let coordPart = trimmed;
  let side: PcbSide = 'top';
  const spaceIdx = trimmed.search(/\s+/);
  if (spaceIdx >= 0) {
    coordPart = trimmed.slice(0, spaceIdx);
    const sideTok = trimmed.slice(spaceIdx).trim().toLowerCase();
    if (sideTok !== 'top' && sideTok !== 'bottom') return undefined;
    side = sideTok;
  }

  const parts = coordPart.split(',').map(s => s.trim());
  if (parts.length < 2 || parts.length > 4) return undefined;
  if (spaceIdx < 0 && parts.length >= 3) {
    const last = parts[parts.length - 1]!.toLowerCase();
    if (last === 'top' || last === 'bottom') {
      side = last;
      parts.pop();
    }
  }
  if (parts.length < 2 || parts.length > 3) return undefined;

  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  let rot = 0;
  if (parts.length === 3) {
    rot = Number(parts[2]);
    if (!Number.isFinite(rot)) return undefined;
    rot = ((rot % 360) + 360) % 360;
    if (Object.is(rot, -0)) rot = 0;
  }

  return {
    x: Object.is(x, -0) ? 0 : x,
    y: Object.is(y, -0) ? 0 : y,
    rot,
    side,
  };
}

/** Format a PCB placement struct into canonical CNL `x,y[,rot][ bottom]`. */
export function formatPcbPlace(p: PcbPlace): string {
  const rot = ((p.rot % 360) + 360) % 360;
  const rotNorm = Math.round(rot * 1e4) / 1e4;
  const base = rotNorm !== 0 ? `${fmtMm(p.x)},${fmtMm(p.y)},${fmtMm(rotNorm)}` : `${fmtMm(p.x)},${fmtMm(p.y)}`;
  return p.side === 'bottom' ? `${base} bottom` : base;
}

function flipPadLayers(layers: PadLayers, side: PcbSide): PadLayers {
  if (layers === 'TH' || side === 'top') return layers;
  return layers === 'F' ? 'B' : 'F';
}

/** Resolve world-space pad instances for all PCB-placed components. */
export function pads(q: Query): PadInstance[] {
  const out: PadInstance[] = [];
  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const place = parsePcbPlace(comp.place.pcb);
    if (!place) continue;
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    const fp = footprint(fpName);

    for (const pad of fp.pads) {
      const key = pinKey(comp.id, pad.id);
      const hasPin = part.pins.some(p => p.id === pad.id);
      const pinLabel = hasPin ? q.pinLabel(key) : `${comp.ref}.${pad.id}`;
      const net = hasPin ? q.netOfPin(key) : undefined;
      out.push({
        ref: comp.ref,
        compId: comp.id,
        pinId: pad.id,
        pinLabel,
        ...(net ? { netId: net.id, net: net.name } : {}),
        shape: pad.shape,
        at: transformPoint(pad.at, place),
        size: [pad.size[0], pad.size[1]],
        rot: place.rot,
        ...(pad.drill !== undefined ? { drill: pad.drill } : {}),
        layers: flipPadLayers(pad.layers, place.side),
        ...(pad.roundRadius !== undefined ? { roundRadius: pad.roundRadius } : {}),
      });
    }
  }
  return out;
}

const POWER_NET_RE = /^(GND|AGND|DGND|PGND|VSS|VCC|VDD|AVDD|DVDD|5V|3V3|VIN|VBAT|VBUS)$/i;

interface CompEntry {
  comp: Component;
  part: PartDef;
  fp: Footprint;
}

/** Auto-place PCB components inside the board outline, avoiding courtyard overlaps and grouping connected parts. */
export function autoPlacePcb(q: Query, opts: PcbPlaceOptions = {}): PcbPlaceResult {
  const onlyRefs = opts.refs?.length ? new Set(opts.refs.map(r => r.toUpperCase())) : undefined;
  const targets: CompEntry[] = [];
  const fixed: { entry: CompEntry; place: PcbPlace; corners: Point[]; padPts: Map<string, Point[]> }[] = [];
  const allEntries: CompEntry[] = [];

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    const fp = footprint(fpName);
    const entry: CompEntry = { comp, part, fp };
    allEntries.push(entry);

    const parsed = parsePcbPlace(comp.place.pcb);
    const selected = onlyRefs ? onlyRefs.has(comp.ref.toUpperCase()) : true;
    const shouldPlace = selected && (opts.all || !parsed);
    if (shouldPlace) {
      targets.push(entry);
    } else if (parsed) {
      const padPts = new Map<string, Point[]>();
      for (const pad of fp.pads) {
        const net = q.netOfPin(pinKey(comp.id, pad.id));
        if (!net) continue;
        const list = padPts.get(net.id) ?? [];
        list.push(transformPoint(pad.at, parsed));
        padPts.set(net.id, list);
      }
      fixed.push({ entry, place: parsed, corners: compCourtyardCorners(fp, parsed), padPts });
    }
  }

  if (targets.length === 0) return { place: {}, notes: [] };

  const explicitBoard = q.circuit.pcb?.board?.outline;
  const board = explicitBoard && explicitBoard.length >= 3
    ? explicitBoard
    : autoBoardOutline(allEntries.map(e => e.fp));
  const bBounds = polyBounds(board);
  const boardCx = (bBounds.minX + bBounds.maxX) / 2;
  const boardCy = (bBounds.minY + bBounds.maxY) / 2;

  // Build component-to-component net adjacency weights (signal nets weighted higher than power rails)
  const compNets = new Map<string, Set<string>>();
  for (const e of allEntries) {
    const set = new Set<string>();
    for (const p of e.part.pins) {
      const net = q.netOfPin(pinKey(e.comp.id, p.id));
      if (net) set.add(net.id);
    }
    compNets.set(e.comp.id, set);
  }

  const netWeight = (netId: string): number => {
    const net = q.circuit.nets[netId];
    return net && POWER_NET_RE.test(net.name) ? 1 : 3;
  };

  // Placed state tracked during greedy placement
  const placedBoxes: { corners: Point[]; padPts: Map<string, Point[]>; compId: string }[] = fixed.map(f => ({
    corners: f.corners,
    padPts: f.padPts,
    compId: f.entry.comp.id,
  }));
  const placedIds = new Set(fixed.map(f => f.entry.comp.id));

  // Order targets greedily by connectivity to already-placed components, then size, then natural ref
  const remaining = [...targets];
  const ordered: CompEntry[] = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestConn = -1;
    let bestArea = -1;
    for (let i = 0; i < remaining.length; i++) {
      const e = remaining[i]!;
      const nets = compNets.get(e.comp.id)!;
      let conn = 0;
      for (const nid of nets) {
        for (const pid of placedIds) {
          if (compNets.get(pid)?.has(nid)) conn += netWeight(nid);
        }
      }
      const area = e.fp.courtyard[0] * e.fp.courtyard[1];
      if (
        conn > bestConn
        || (conn === bestConn && area > bestArea + 1e-6)
        || (conn === bestConn && Math.abs(area - bestArea) <= 1e-6 && naturalCompare(e.comp.ref, remaining[bestIdx]!.comp.ref) < 0)
      ) {
        bestConn = conn;
        bestArea = area;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0]!;
    ordered.push(chosen);
    placedIds.add(chosen.comp.id);
  }
  // Reset placedIds to only truly placed components for target centroid calculation
  const actuallyPlacedIds = new Set(fixed.map(f => f.entry.comp.id));

  const notes: string[] = [];
  if (!explicitBoard || explicitBoard.length < 3) {
    notes.push(`auto board ${fmtMm(bBounds.maxX - bBounds.minX)}x${fmtMm(bBounds.maxY - bBounds.minY)} mm`);
  }

  const placeMap: Record<string, string> = {};
  const snap05 = (v: number) => roundMm(Math.round(v * 2) / 2);

  for (const { comp, fp } of ordered) {
    // Target centroid from connected already-placed pads
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    for (const pad of fp.pads) {
      const net = q.netOfPin(pinKey(comp.id, pad.id));
      if (!net) continue;
      const w = netWeight(net.id);
      for (const pb of placedBoxes) {
        if (!actuallyPlacedIds.has(pb.compId)) continue;
        const pts = pb.padPts.get(net.id);
        if (!pts) continue;
        for (const pt of pts) {
          sumX += pt[0] * w;
          sumY += pt[1] * w;
          sumW += w;
        }
      }
    }
    const targetX = sumW > 0 ? snap05(sumX / sumW) : snap05(boardCx);
    const targetY = sumW > 0 ? snap05(sumY / sumW) : snap05(boardCy);

    const step = 1.0;
    const candidates: [number, number][] = [];
    const seenPt = new Set<string>();
    const addCand = (cx: number, cy: number) => {
      const rx = roundMm(cx);
      const ry = roundMm(cy);
      const k = `${rx},${ry}`;
      if (!seenPt.has(k)) {
        seenPt.add(k);
        candidates.push([rx, ry]);
      }
    };
    addCand(targetX, targetY);
    for (let x = Math.ceil(bBounds.minX * 2) / 2; x <= bBounds.maxX; x += step) {
      for (let y = Math.ceil(bBounds.minY * 2) / 2; y <= bBounds.maxY; y += step) {
        addCand(x, y);
      }
    }
    candidates.sort((a, b) => {
      const da = (a[0] - targetX) ** 2 + (a[1] - targetY) ** 2;
      const db = (b[0] - targetX) ** 2 + (b[1] - targetY) ** 2;
      return da - db || a[1] - b[1] || a[0] - b[0];
    });

    const evalCandidate = (pl: PcbPlace, margin: number): number | undefined => {
      const inner = compCourtyardCorners(fp, pl, margin);
      if (!polyInsideBoard(inner, board)) return undefined;
      for (const pb of placedBoxes) {
        if (polyIntersects(inner, pb.corners)) return undefined;
      }
      let wireDist = 0;
      for (const pad of fp.pads) {
        const net = q.netOfPin(pinKey(comp.id, pad.id));
        if (!net) continue;
        const w = netWeight(net.id);
        const wpt = transformPoint(pad.at, pl);
        for (const pb of placedBoxes) {
          const pts = pb.padPts.get(net.id);
          if (!pts) continue;
          let bestD = Infinity;
          for (const pt of pts) {
            const d = Math.hypot(wpt[0] - pt[0], wpt[1] - pt[1]);
            if (d < bestD) bestD = d;
          }
          if (Number.isFinite(bestD)) wireDist += bestD * w;
        }
      }
      const centerDist = Math.hypot(pl.x - targetX, pl.y - targetY) * 0.1;
      const rotPen = pl.rot === 0 ? 0 : 0.25 + pl.rot * 1e-4;
      return wireDist + centerDist + rotPen;
    };

    let bestPlace: PcbPlace | undefined;
    let bestScore = Infinity;

    for (const margin of [1.5, 0.5, 0]) {
      for (const [cx, cy] of candidates) {
        // Prune candidates farther away once we already have a good placement
        if (bestPlace && Math.hypot(cx - targetX, cy - targetY) * 0.1 > bestScore + 25) break;
        for (const rot of [0, 90, 180, 270]) {
          const pl: PcbPlace = { x: cx, y: cy, rot, side: 'top' };
          const score = evalCandidate(pl, margin);
          if (score !== undefined && score < bestScore - 1e-6) {
            bestScore = score;
            bestPlace = pl;
          }
        }
      }
      if (bestPlace) break;
    }

    if (!bestPlace) {
      // Fallback outside board if board is too small for all components
      const hw = fp.courtyard[0] / 2;
      const hh = fp.courtyard[1] / 2;
      let fx = snap05(bBounds.maxX + hw + 2);
      const fy = snap05(bBounds.minY + hh + 1);
      for (let tries = 0; tries < 50; tries++) {
        const pl: PcbPlace = { x: fx, y: fy, rot: 0, side: 'top' };
        const corners = compCourtyardCorners(fp, pl, 0.25);
        if (!placedBoxes.some(pb => polyIntersects(corners, pb.corners))) {
          bestPlace = pl;
          break;
        }
        fx = snap05(fx + fp.courtyard[0] + 1);
      }
      bestPlace ??= { x: fx, y: fy, rot: 0, side: 'top' };
      notes.push(`${comp.ref}: did not fit inside board outline`);
    }

    placeMap[comp.ref] = formatPcbPlace(bestPlace);
    const padPts = new Map<string, Point[]>();
    for (const pad of fp.pads) {
      const net = q.netOfPin(pinKey(comp.id, pad.id));
      if (!net) continue;
      const list = padPts.get(net.id) ?? [];
      list.push(transformPoint(pad.at, bestPlace));
      padPts.set(net.id, list);
    }
    placedBoxes.push({
      corners: compCourtyardCorners(fp, bestPlace),
      padPts,
      compId: comp.id,
    });
    actuallyPlacedIds.add(comp.id);
  }

  return { place: placeMap, notes };
}

/** Placement-level PCB checks (unplaced, bad_place, off_board, overlap). Used before WP2 DRC lands. */
export function checkPcbPlace(q: Query): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const unplaced: string[] = [];
  const board = q.circuit.pcb?.board?.outline;
  const placed: { ref: string; fp: Footprint; place: PcbPlace; corners: Point[] }[] = [];

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const raw = comp.place.pcb;
    if (raw === undefined || raw.trim() === '') {
      unplaced.push(comp.ref);
      continue;
    }
    const parsed = parsePcbPlace(raw);
    if (!parsed) {
      issues.push({
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: invalid PCB placement "${raw}" (expected x,y[,rot][,top|bottom])`,
        at: [comp.ref],
      });
      continue;
    }
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    let fp: Footprint;
    try {
      fp = footprint(fpName);
    } catch {
      issues.push({
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: unknown footprint "${fpName}"`,
        at: [comp.ref],
      });
      continue;
    }
    const corners = compCourtyardCorners(fp, parsed);
    placed.push({ ref: comp.ref, fp, place: parsed, corners });

    if (board && board.length >= 3) {
      const padOutside = fp.pads.some(p => !pointInPolygon(transformPoint(p.at, parsed), board));
      if (padOutside || !polyInsideBoard(corners, board)) {
        issues.push({
          level: 'error',
          code: 'off_board',
          message: `${comp.ref} extends outside board outline`,
          at: [comp.ref],
        });
      }
    }
  }

  if (unplaced.length > 0) {
    issues.push({
      level: 'warn',
      code: 'unplaced',
      message: `unplaced in pcb: ${unplaced.join(', ')}`,
      at: unplaced,
    });
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (polyIntersects(a.corners, b.corners)) {
        issues.push({
          level: 'error',
          code: 'overlap',
          message: `${a.ref} and ${b.ref} courtyards overlap`,
          at: [a.ref, b.ref],
        });
      }
    }
  }

  return issues;
}
