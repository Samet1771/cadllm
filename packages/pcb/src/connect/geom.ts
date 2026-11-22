// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PcbLayer, PcbVia } from '@cadllm/core';
import { pointInPolygon } from '../place/geometry.ts';
import type { PadInstance, Point } from '../types.ts';

export type CopperCore =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'segment'; ax: number; ay: number; bx: number; by: number }
  | { kind: 'rect'; cx: number; cy: number; hw: number; hh: number; cos: number; sin: number };

export interface CopperShape {
  core: CopperCore;
  r: number;
  layers: readonly PcbLayer[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const fmtMm = (n: number): string => {
  const r = Math.abs(n) < 1e-9 ? 0 : n;
  return r.toFixed(2);
};

export function padLayersOf(layers: PadInstance['layers']): readonly PcbLayer[] {
  if (layers === 'TH') return ['F', 'B'];
  return layers === 'F' ? ['F'] : ['B'];
}

export function layersOverlap(a: readonly PcbLayer[], b: readonly PcbLayer[]): PcbLayer[] {
  const out: PcbLayer[] = [];
  for (const l of a) if (b.includes(l)) out.push(l);
  return out;
}

function trigDeg(deg: number): [cos: number, sin: number] {
  const rad = (deg * Math.PI) / 180;
  let c = Math.cos(rad);
  let s = Math.sin(rad);
  if (Math.abs(c) < 1e-12) c = 0;
  else if (Math.abs(c - 1) < 1e-12) c = 1;
  else if (Math.abs(c + 1) < 1e-12) c = -1;
  if (Math.abs(s) < 1e-12) s = 0;
  else if (Math.abs(s - 1) < 1e-12) s = 1;
  else if (Math.abs(s + 1) < 1e-12) s = -1;
  return [c, s];
}

function makeShape(core: CopperCore, r: number, layers: readonly PcbLayer[]): CopperShape {
  if (core.kind === 'point') {
    return { core, r, layers, minX: core.x - r, minY: core.y - r, maxX: core.x + r, maxY: core.y + r };
  }
  if (core.kind === 'segment') {
    return {
      core,
      r,
      layers,
      minX: Math.min(core.ax, core.bx) - r,
      minY: Math.min(core.ay, core.by) - r,
      maxX: Math.max(core.ax, core.bx) + r,
      maxY: Math.max(core.ay, core.by) + r,
    };
  }
  const ex = Math.abs(core.hw * core.cos) + Math.abs(core.hh * core.sin);
  const ey = Math.abs(core.hw * core.sin) + Math.abs(core.hh * core.cos);
  return {
    core,
    r,
    layers,
    minX: core.cx - ex - r,
    minY: core.cy - ey - r,
    maxX: core.cx + ex + r,
    maxY: core.cy + ey + r,
  };
}

export function padToShape(pad: PadInstance): CopperShape {
  const [cx, cy] = pad.at;
  const [w, h] = pad.size;
  const layers = padLayersOf(pad.layers);
  const [cos, sin] = trigDeg(pad.rot);

  if (pad.shape === 'circle' && Math.abs(w - h) <= 1e-6) {
    return makeShape({ kind: 'point', x: cx, y: cy }, w / 2, layers);
  }
  if (pad.shape === 'oval' || pad.shape === 'circle') {
    const r = Math.min(w, h) / 2;
    if (Math.abs(w - h) <= 1e-6) {
      return makeShape({ kind: 'point', x: cx, y: cy }, r, layers);
    }
    const halfSpan = Math.abs(w - h) / 2;
    const dx = w >= h ? halfSpan * cos : halfSpan * -sin;
    const dy = w >= h ? halfSpan * sin : halfSpan * cos;
    return makeShape({ kind: 'segment', ax: cx - dx, ay: cy - dy, bx: cx + dx, by: cy + dy }, r, layers);
  }

  let r = 0;
  if (pad.shape === 'roundrect') {
    const ratio = Math.max(0, Math.min(0.5, pad.roundRadius ?? 0.25));
    r = ratio * Math.min(w, h);
    if (r >= Math.min(w, h) / 2 - 1e-6) {
      const halfSpan = Math.abs(w - h) / 2;
      if (halfSpan <= 1e-6) return makeShape({ kind: 'point', x: cx, y: cy }, r, layers);
      const dx = w >= h ? halfSpan * cos : halfSpan * -sin;
      const dy = w >= h ? halfSpan * sin : halfSpan * cos;
      return makeShape({ kind: 'segment', ax: cx - dx, ay: cy - dy, bx: cx + dx, by: cy + dy }, r, layers);
    }
  }
  return makeShape(
    { kind: 'rect', cx, cy, hw: Math.max(0, w / 2 - r), hh: Math.max(0, h / 2 - r), cos, sin },
    r,
    layers,
  );
}

export function segmentToShape(ax: number, ay: number, bx: number, by: number, width: number, layer: PcbLayer): CopperShape {
  const r = width / 2;
  if (Math.hypot(bx - ax, by - ay) <= 1e-9) {
    return makeShape({ kind: 'point', x: ax, y: ay }, r, [layer]);
  }
  return makeShape({ kind: 'segment', ax, ay, bx, by }, r, [layer]);
}

export function viaToShape(via: PcbVia): CopperShape {
  return makeShape({ kind: 'point', x: via.at[0], y: via.at[1] }, via.size / 2, ['F', 'B']);
}

export function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): { dist: number; cx: number; cy: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-18) return { dist: Math.hypot(px - ax, py - ay), cx: ax, cy: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), cx, cy };
}

function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onBox(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  return x >= Math.min(x1, x2) - 1e-9 && x <= Math.max(x1, x2) + 1e-9
    && y >= Math.min(y1, y2) - 1e-9 && y <= Math.max(y1, y2) + 1e-9;
}

export function segToSegDist(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): { dist: number; p1: Point; p2: Point } {
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);

  if (((o1 > 1e-11 && o2 < -1e-11) || (o1 < -1e-11 && o2 > 1e-11))
    && ((o3 > 1e-11 && o4 < -1e-11) || (o3 < -1e-11 && o4 > 1e-11))) {
    const denom = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
    if (Math.abs(denom) > 1e-12) {
      const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / denom;
      const ix = ax + t * (bx - ax);
      const iy = ay + t * (by - ay);
      return { dist: 0, p1: [ix, iy], p2: [ix, iy] };
    }
  }

  // Collinear overlap check
  if (Math.abs(o1) <= 1e-9 && Math.abs(o2) <= 1e-9 && Math.abs(o3) <= 1e-9 && Math.abs(o4) <= 1e-9) {
    const pts: Point[] = [];
    if (onBox(ax, ay, cx, cy, dx, dy)) pts.push([ax, ay]);
    if (onBox(bx, by, cx, cy, dx, dy)) pts.push([bx, by]);
    if (onBox(cx, cy, ax, ay, bx, by)) pts.push([cx, cy]);
    if (onBox(dx, dy, ax, ay, bx, by)) pts.push([dx, dy]);
    if (pts.length > 0) {
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return { dist: 0, p1: [mx, my], p2: [mx, my] };
    }
  }

  let bestDist = Infinity;
  let bestP1: Point = [ax, ay];
  let bestP2: Point = [cx, cy];

  const check = (px: number, py: number, sx1: number, sy1: number, sx2: number, sy2: number, swap: boolean) => {
    const r = pointToSegDist(px, py, sx1, sy1, sx2, sy2);
    if (r.dist < bestDist) {
      bestDist = r.dist;
      if (swap) { bestP1 = [r.cx, r.cy]; bestP2 = [px, py]; }
      else { bestP1 = [px, py]; bestP2 = [r.cx, r.cy]; }
    }
  };

  check(ax, ay, cx, cy, dx, dy, false);
  check(bx, by, cx, cy, dx, dy, false);
  check(cx, cy, ax, ay, bx, by, true);
  check(dx, dy, ax, ay, bx, by, true);
  return { dist: bestDist, p1: bestP1, p2: bestP2 };
}

type RectCore = Extract<CopperCore, { kind: 'rect' }>;

function toLocal(x: number, y: number, rc: RectCore): [number, number] {
  const dx = x - rc.cx;
  const dy = y - rc.cy;
  return [dx * rc.cos + dy * rc.sin, -dx * rc.sin + dy * rc.cos];
}

function toWorld(lx: number, ly: number, rc: RectCore): Point {
  return [rc.cx + lx * rc.cos - ly * rc.sin, rc.cy + lx * rc.sin + ly * rc.cos];
}

function rectCorners(rc: RectCore): [Point, Point, Point, Point] {
  return [
    toWorld(-rc.hw, -rc.hh, rc),
    toWorld(rc.hw, -rc.hh, rc),
    toWorld(rc.hw, rc.hh, rc),
    toWorld(-rc.hw, rc.hh, rc),
  ];
}

export function pointToRectDist(px: number, py: number, rc: RectCore): { dist: number; cx: number; cy: number } {
  const [lx, ly] = toLocal(px, py, rc);
  const clampedX = Math.max(-rc.hw, Math.min(rc.hw, lx));
  const clampedY = Math.max(-rc.hh, Math.min(rc.hh, ly));
  const [cx, cy] = toWorld(clampedX, clampedY, rc);
  return { dist: Math.hypot(lx - clampedX, ly - clampedY), cx, cy };
}

function segIntersectsAabb(ax: number, ay: number, bx: number, by: number, hw: number, hh: number): Point | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const checks: [number, number][] = [
    [-dx, ax + hw],
    [dx, hw - ax],
    [-dy, ay + hh],
    [dy, hh - ay],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) <= 1e-12) {
      if (q < -1e-12) return undefined;
    } else {
      const u = q / p;
      if (p < 0) {
        if (u > t1 + 1e-12) return undefined;
        if (u > t0) t0 = u;
      } else {
        if (u < t0 - 1e-12) return undefined;
        if (u < t1) t1 = u;
      }
    }
  }
  if (t0 > t1 + 1e-12) return undefined;
  const tm = (Math.max(0, t0) + Math.min(1, t1)) / 2;
  return [ax + tm * dx, ay + tm * dy];
}

export function segToRectDist(
  ax: number, ay: number, bx: number, by: number, rc: RectCore,
): { dist: number; p1: Point; p2: Point } {
  const [axl, ayl] = toLocal(ax, ay, rc);
  const [bxl, byl] = toLocal(bx, by, rc);
  const hit = segIntersectsAabb(axl, ayl, bxl, byl, rc.hw, rc.hh);
  if (hit) {
    const w = toWorld(hit[0], hit[1], rc);
    return { dist: 0, p1: w, p2: w };
  }

  let bestDist = Infinity;
  let bestP1: Point = [ax, ay];
  let bestP2: Point = [rc.cx, rc.cy];

  const checkPt = (lx: number, ly: number, wx: number, wy: number) => {
    const cx = Math.max(-rc.hw, Math.min(rc.hw, lx));
    const cy = Math.max(-rc.hh, Math.min(rc.hh, ly));
    const d = Math.hypot(lx - cx, ly - cy);
    if (d < bestDist) {
      bestDist = d;
      bestP1 = [wx, wy];
      bestP2 = toWorld(cx, cy, rc);
    }
  };
  checkPt(axl, ayl, ax, ay);
  checkPt(bxl, byl, bx, by);

  const corners: [number, number][] = [[-rc.hw, -rc.hh], [rc.hw, -rc.hh], [rc.hw, rc.hh], [-rc.hw, rc.hh]];
  for (const [cx, cy] of corners) {
    const r = pointToSegDist(cx, cy, axl, ayl, bxl, byl);
    if (r.dist < bestDist) {
      bestDist = r.dist;
      bestP1 = toWorld(r.cx, r.cy, rc);
      bestP2 = toWorld(cx, cy, rc);
    }
  }
  return { dist: bestDist, p1: bestP1, p2: bestP2 };
}

function rectsOverlapSat(ca: readonly Point[], cb: readonly Point[], axes: readonly [number, number][]): boolean {
  for (const [ax, ay] of axes) {
    let minA = Infinity, maxA = -Infinity;
    for (const [x, y] of ca) {
      const p = x * ax + y * ay;
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }
    let minB = Infinity, maxB = -Infinity;
    for (const [x, y] of cb) {
      const p = x * ax + y * ay;
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }
    if (maxA < minB - 1e-9 || maxB < minA - 1e-9) return false;
  }
  return true;
}

export function rectToRectDist(a: RectCore, b: RectCore): { dist: number; p1: Point; p2: Point } {
  const ca = rectCorners(a);
  const cb = rectCorners(b);
  const axes: [number, number][] = [
    [a.cos, a.sin], [-a.sin, a.cos],
    [b.cos, b.sin], [-b.sin, b.cos],
  ];
  if (rectsOverlapSat(ca, cb, axes)) {
    const insidePts: Point[] = [];
    for (const p of ca) if (pointToRectDist(p[0], p[1], b).dist <= 1e-7) insidePts.push(p);
    for (const p of cb) if (pointToRectDist(p[0], p[1], a).dist <= 1e-7) insidePts.push(p);
    const mx = insidePts.length > 0
      ? insidePts.reduce((s, p) => s + p[0], 0) / insidePts.length
      : (a.cx + b.cx) / 2;
    const my = insidePts.length > 0
      ? insidePts.reduce((s, p) => s + p[1], 0) / insidePts.length
      : (a.cy + b.cy) / 2;
    return { dist: 0, p1: [mx, my], p2: [mx, my] };
  }

  let bestDist = Infinity;
  let bestP1: Point = [a.cx, a.cy];
  let bestP2: Point = [b.cx, b.cy];
  for (const [x, y] of ca) {
    const r = pointToRectDist(x, y, b);
    if (r.dist < bestDist) { bestDist = r.dist; bestP1 = [x, y]; bestP2 = [r.cx, r.cy]; }
  }
  for (const [x, y] of cb) {
    const r = pointToRectDist(x, y, a);
    if (r.dist < bestDist) { bestDist = r.dist; bestP1 = [r.cx, r.cy]; bestP2 = [x, y]; }
  }
  return { dist: bestDist, p1: bestP1, p2: bestP2 };
}

export function coreDist(a: CopperCore, b: CopperCore): { dist: number; p1: Point; p2: Point } {
  if (a.kind === 'point') {
    if (b.kind === 'point') return { dist: Math.hypot(a.x - b.x, a.y - b.y), p1: [a.x, a.y], p2: [b.x, b.y] };
    if (b.kind === 'segment') {
      const r = pointToSegDist(a.x, a.y, b.ax, b.ay, b.bx, b.by);
      return { dist: r.dist, p1: [a.x, a.y], p2: [r.cx, r.cy] };
    }
    const r = pointToRectDist(a.x, a.y, b);
    return { dist: r.dist, p1: [a.x, a.y], p2: [r.cx, r.cy] };
  }
  if (a.kind === 'segment') {
    if (b.kind === 'point') {
      const r = pointToSegDist(b.x, b.y, a.ax, a.ay, a.bx, a.by);
      return { dist: r.dist, p1: [r.cx, r.cy], p2: [b.x, b.y] };
    }
    if (b.kind === 'segment') return segToSegDist(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
    return segToRectDist(a.ax, a.ay, a.bx, a.by, b);
  }
  if (b.kind === 'point') {
    const r = pointToRectDist(b.x, b.y, a);
    return { dist: r.dist, p1: [r.cx, r.cy], p2: [b.x, b.y] };
  }
  if (b.kind === 'segment') {
    const r = segToRectDist(b.ax, b.ay, b.bx, b.by, a);
    return { dist: r.dist, p1: r.p2, p2: r.p1 };
  }
  return rectToRectDist(a, b);
}

/** Signed copper edge-to-edge distance (<= 0 means touching/overlapping) and witness point. */
export function shapeDistAndPoint(a: CopperShape, b: CopperShape): { dist: number; point: Point } {
  const c = coreDist(a.core, b.core);
  return {
    dist: c.dist - a.r - b.r,
    point: [(c.p1[0] + c.p2[0]) / 2, (c.p1[1] + c.p2[1]) / 2],
  };
}

export function pointToShapeDist(px: number, py: number, s: CopperShape): number {
  if (s.core.kind === 'point') return Math.hypot(px - s.core.x, py - s.core.y) - s.r;
  if (s.core.kind === 'segment') return pointToSegDist(px, py, s.core.ax, s.core.ay, s.core.bx, s.core.by).dist - s.r;
  return pointToRectDist(px, py, s.core).dist - s.r;
}

export function segToShapeDist(ax: number, ay: number, bx: number, by: number, segHalfW: number, s: CopperShape): number {
  const segCore: CopperCore = Math.hypot(bx - ax, by - ay) <= 1e-9
    ? { kind: 'point', x: ax, y: ay }
    : { kind: 'segment', ax, ay, bx, by };
  return coreDist(segCore, s.core).dist - segHalfW - s.r;
}

function coreVertices(core: CopperCore): Point[] {
  if (core.kind === 'point') return [[core.x, core.y]];
  if (core.kind === 'segment') return [[core.ax, core.ay], [core.bx, core.by]];
  return rectCorners(core);
}

/** Check if a copper shape lies inside the board polygon and measure its clearance to board edges. */
export function shapeInsideBoardDist(
  s: CopperShape,
  board: Point[],
): { inside: boolean; edgeClearance: number; point: Point } {
  const verts = coreVertices(s.core);
  let minDist = Infinity;
  let witness: Point = verts[0]!;

  for (let i = 0; i < board.length; i++) {
    const e1 = board[i]!;
    const e2 = board[(i + 1) % board.length]!;
    const c = coreDist(s.core, { kind: 'segment', ax: e1[0], ay: e1[1], bx: e2[0], by: e2[1] });
    if (c.dist < minDist) {
      minDist = c.dist;
      witness = c.p1;
    }
  }

  for (const v of verts) {
    if (!pointInPolygon(v, board, 1e-6)) {
      return { inside: false, edgeClearance: -minDist - s.r, point: v };
    }
  }

  if (minDist <= 1e-9) {
    return { inside: false, edgeClearance: -s.r, point: witness };
  }

  const edgeClearance = minDist - s.r;
  return {
    inside: edgeClearance >= -1e-6,
    edgeClearance,
    point: witness,
  };
}
