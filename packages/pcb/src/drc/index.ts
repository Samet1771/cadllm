// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { DEFAULT_PCB_RULES, naturalCompare, type PcbRules, type Query } from '@cadllm/core';
import { analyzeConnectivity, type CopperItem } from '../connect/index.ts';
import { fmtMm, layersOverlap, shapeDistAndPoint, shapeInsideBoardDist } from '../connect/geom.ts';
import { componentFootprintName, footprint, isPcbPart } from '../footprints/index.ts';
import { compCourtyardCorners, polyInsideBoard, polyIntersects } from '../place/geometry.ts';
import { parsePcbPlace } from '../place/index.ts';
import type { DrcIssue, DrcOptions, Footprint, PcbPlace, Point } from '../types.ts';

const EPS = 1e-5;

function resolveFootprint(
  fpName: string,
  injected?: Record<string, Footprint>,
): Footprint | undefined {
  if (injected && fpName in injected) return injected[fpName];
  try {
    return footprint(fpName);
  } catch {
    return undefined;
  }
}

function courtyardCenter(corners: Point[]): Point {
  const sx = corners.reduce((s, p) => s + p[0], 0);
  const sy = corners.reduce((s, p) => s + p[1], 0);
  return [sx / corners.length, sy / corners.length];
}

function netTokensOf(item: CopperItem): string[] {
  const out: string[] = [];
  if (item.pad) out.push(item.pad.pinLabel);
  if (item.netId) out.push(item.netName);
  return out;
}

/** Run PCB design rule and connectivity checks. */
export function drc(q: Query, opts?: DrcOptions): DrcIssue[] {
  const rules: PcbRules = { ...DEFAULT_PCB_RULES, ...q.circuit.pcb?.rules };
  const board = q.circuit.pcb?.board?.outline;
  const hasBoard = board !== undefined && board.length >= 3;

  const analysis = analyzeConnectivity(q, opts?.pads ? { pads: opts.pads } : undefined);
  const issues: DrcIssue[] = [];

  const unplaced: string[] = [];
  const placedComps: { ref: string; fp: Footprint; place: PcbPlace; corners: Point[]; isSmd: boolean }[] = [];
  const offBoardComps = new Set<string>();

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part) continue;
    const raw = comp.place.pcb;
    if (!isPcbPart(part)) {
      if (raw !== undefined && raw.trim() !== '') {
        issues.push({
          level: 'error',
          code: 'bad_place',
          message: `${comp.ref}: ${part.id} is not a PCB part`,
          at: [comp.ref],
        });
      }
      continue;
    }

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
    const fp = resolveFootprint(fpName, opts?.footprints);
    if (!fp) {
      issues.push({
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: unknown footprint "${fpName}"`,
        at: [comp.ref],
      });
      continue;
    }

    const corners = compCourtyardCorners(fp, parsed);
    const isSmd = !fp.pads.some(p => p.layers === 'TH');
    placedComps.push({ ref: comp.ref, fp, place: parsed, corners, isSmd });

    if (hasBoard && !polyInsideBoard(corners, board)) {
      offBoardComps.add(comp.ref);
      const [cx, cy] = courtyardCenter(corners);
      issues.push({
        level: 'error',
        code: 'off_board',
        message: `${comp.ref} courtyard at (${fmtMm(cx)}, ${fmtMm(cy)}) mm extends outside board outline`,
        at: [comp.ref],
      });
    }
  }

  if (unplaced.length > 0) {
    issues.push({
      level: 'warn',
      code: 'unplaced',
      message: `unplaced in PCB: ${unplaced.join(', ')}`,
      at: unplaced,
    });
  }

  // Board-edge copper checks (pads, tracks, vias)
  if (hasBoard) {
    const worstTrackOff = new Map<number, { item: CopperItem; edgeClearance: number; inside: boolean; point: Point }>();
    for (const item of analysis.items) {
      if (item.kind === 'pad' && offBoardComps.has(item.pad!.ref)) continue;
      const res = shapeInsideBoardDist(item.shape, board);
      if (!res.inside || res.edgeClearance < rules.clearance - EPS) {
        if (item.kind === 'track') {
          const ti = item.trackIndex!;
          const prev = worstTrackOff.get(ti);
          if (!prev || res.edgeClearance < prev.edgeClearance) {
            worstTrackOff.set(ti, { item, ...res });
          }
          continue;
        }
        const at = netTokensOf(item);
        const msg = !res.inside
          ? `${item.label} at (${fmtMm(res.point[0])}, ${fmtMm(res.point[1])}) mm extends outside board outline`
          : `${item.label} at (${fmtMm(res.point[0])}, ${fmtMm(res.point[1])}) mm is ${fmtMm(Math.max(0, res.edgeClearance))} mm from board edge (min ${fmtMm(rules.clearance)} mm)`;
        issues.push({ level: 'error', code: 'off_board', message: msg, at });
      }
    }
    for (const [, v] of [...worstTrackOff.entries()].sort((a, b) => a[0] - b[0])) {
      const msg = !v.inside
        ? `${v.item.label} at (${fmtMm(v.point[0])}, ${fmtMm(v.point[1])}) mm extends outside board outline`
        : `${v.item.label} at (${fmtMm(v.point[0])}, ${fmtMm(v.point[1])}) mm is ${fmtMm(Math.max(0, v.edgeClearance))} mm from board edge (min ${fmtMm(rules.clearance)} mm)`;
      issues.push({ level: 'error', code: 'off_board', message: msg, at: netTokensOf(v.item) });
    }
  }

  // Courtyard overlaps (SMD on opposite sides do not overlap; TH collides with both sides)
  for (let i = 0; i < placedComps.length; i++) {
    const a = placedComps[i]!;
    for (let j = i + 1; j < placedComps.length; j++) {
      const b = placedComps[j]!;
      if (a.isSmd && b.isSmd && a.place.side !== b.place.side) continue;
      if (polyIntersects(a.corners, b.corners)) {
        const [ax, ay] = courtyardCenter(a.corners);
        const [bx, by] = courtyardCenter(b.corners);
        issues.push({
          level: 'error',
          code: 'overlap',
          message: `${a.ref} and ${b.ref} courtyards overlap near (${fmtMm((ax + bx) / 2)}, ${fmtMm((ay + by) / 2)}) mm`,
          at: [a.ref, b.ref],
        });
      }
    }
  }

  // Shorts & clearance violations between copper of different nets
  const pairWorst = new Map<string, {
    a: CopperItem;
    b: CopperItem;
    dist: number;
    point: Point;
    layers: string;
  }>();

  const items = analysis.items;
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (a.netKey === b.netKey) continue;
      if (
        a.shape.maxX + rules.clearance < b.shape.minX
        || b.shape.maxX + rules.clearance < a.shape.minX
        || a.shape.maxY + rules.clearance < b.shape.minY
        || b.shape.maxY + rules.clearance < a.shape.minY
      ) {
        continue;
      }
      const shared = layersOverlap(a.shape.layers, b.shape.layers);
      if (shared.length === 0) continue;
      const { dist, point } = shapeDistAndPoint(a.shape, b.shape);
      if (dist >= rules.clearance - EPS) continue;

      const swap = naturalCompare(a.objectKey, b.objectKey) > 0;
      const first = swap ? b : a;
      const second = swap ? a : b;
      const pairKey = `${first.objectKey}|${second.objectKey}`;
      const prev = pairWorst.get(pairKey);
      if (!prev || dist < prev.dist) {
        pairWorst.set(pairKey, { a: first, b: second, dist, point, layers: shared.join('/') });
      }
    }
  }

  const shorts: DrcIssue[] = [];
  const clearances: DrcIssue[] = [];
  for (const [, v] of [...pairWorst.entries()].sort((x, y) => naturalCompare(x[0], y[0]))) {
    const at = [...new Set([...netTokensOf(v.a), ...netTokensOf(v.b)])];
    const loc = `on ${v.layers} at (${fmtMm(v.point[0])}, ${fmtMm(v.point[1])}) mm`;
    if (v.dist <= EPS) {
      shorts.push({
        level: 'error',
        code: 'short',
        message: `short between ${v.a.label} and ${v.b.label} ${loc}`,
        at,
      });
    } else {
      clearances.push({
        level: 'error',
        code: 'clearance',
        message: `clearance ${fmtMm(v.dist)} mm < ${fmtMm(rules.clearance)} mm between ${v.a.label} and ${v.b.label} ${loc}`,
        at,
      });
    }
  }
  issues.push(...shorts, ...clearances);

  // Min track width
  const pcb = q.circuit.pcb;
  if (pcb) {
    for (const t of pcb.tracks) {
      if (t.width < rules.track - EPS) {
        const netName = q.circuit.nets[t.net]?.name ?? t.net;
        const pt = t.points[0] ?? [0, 0];
        issues.push({
          level: 'error',
          code: 'track_width',
          message: `track ${netName} (${t.layer}) at (${fmtMm(pt[0])}, ${fmtMm(pt[1])}) mm width ${fmtMm(t.width)} mm < min ${fmtMm(rules.track)} mm`,
          at: [netName],
        });
      }
    }
  }

  // Drill checks on TH pads and vias
  for (const pad of analysis.pads) {
    if (pad.layers !== 'TH' || pad.drill === undefined) continue;
    const at = [pad.pinLabel, ...(pad.net ? [pad.net] : [])];
    const minDim = Math.min(pad.size[0], pad.size[1]);
    if (pad.drill < rules.drill - EPS) {
      issues.push({
        level: 'error',
        code: 'drill',
        message: `pad ${pad.pinLabel} at (${fmtMm(pad.at[0])}, ${fmtMm(pad.at[1])}) mm drill ${fmtMm(pad.drill)} mm < min ${fmtMm(rules.drill)} mm`,
        at,
      });
    } else if (pad.drill >= minDim - EPS) {
      issues.push({
        level: 'error',
        code: 'drill',
        message: `pad ${pad.pinLabel} at (${fmtMm(pad.at[0])}, ${fmtMm(pad.at[1])}) mm drill ${fmtMm(pad.drill)} mm >= pad size ${fmtMm(minDim)} mm`,
        at,
      });
    }
  }

  if (pcb) {
    for (const v of pcb.vias) {
      const netName = q.circuit.nets[v.net]?.name ?? v.net;
      if (v.drill < rules.drill - EPS) {
        issues.push({
          level: 'error',
          code: 'drill',
          message: `via ${netName} at (${fmtMm(v.at[0])}, ${fmtMm(v.at[1])}) mm drill ${fmtMm(v.drill)} mm < min ${fmtMm(rules.drill)} mm`,
          at: [netName],
        });
      } else if (v.drill >= v.size - EPS) {
        issues.push({
          level: 'error',
          code: 'drill',
          message: `via ${netName} at (${fmtMm(v.at[0])}, ${fmtMm(v.at[1])}) mm drill ${fmtMm(v.drill)} mm >= via size ${fmtMm(v.size)} mm`,
          at: [netName],
        });
      }
    }
  }

  // Unrouted ratsnest connections
  const rn = analysis.ratsnest;
  for (const conn of rn.connections) {
    const fromDesc = `${conn.fromPin ?? 'copper'} (${fmtMm(conn.from[0])}, ${fmtMm(conn.from[1])}) mm`;
    const toDesc = `${conn.toPin ?? 'copper'} (${fmtMm(conn.to[0])}, ${fmtMm(conn.to[1])}) mm`;
    issues.push({
      level: 'warn',
      code: 'unrouted',
      message: `unrouted ${conn.net}: ${fromDesc} -> ${toDesc}`,
      at: [conn.net, ...(conn.fromPin ? [conn.fromPin] : []), ...(conn.toPin ? [conn.toPin] : [])],
    });
  }

  return issues;
}
