// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { footprintCourtyardBounds } from '../footprints/index.ts';
import type { Footprint, PcbPlace, Point } from '../types.ts';

export const roundMm = (n: number, decimals = 4): number => {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

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

/**
 * Transform local footprint coordinates (+x right, +y down) into world mm:
 * mirror across X=0 first when `side === 'bottom'`, then rotate clockwise, then translate.
 */
export function transformPoint(pt: Point, place: PcbPlace): Point {
  const mx = place.side === 'bottom' ? -pt[0] : pt[0];
  const my = pt[1];
  const [c, s] = trigDeg(place.rot);
  return [
    roundMm(place.x + mx * c - my * s),
    roundMm(place.y + mx * s + my * c),
  ];
}

export function footprintLocalCorners(fp: Footprint, pad = 0): Point[] {
  const b = footprintCourtyardBounds(fp);
  return [
    [b.minX - pad, b.minY - pad],
    [b.maxX + pad, b.minY - pad],
    [b.maxX + pad, b.maxY + pad],
    [b.minX - pad, b.maxY + pad],
  ];
}

export function compCourtyardCorners(fp: Footprint, place: PcbPlace, pad = 0): Point[] {
  return footprintLocalCorners(fp, pad).map(pt => transformPoint(pt, place));
}

export function polyBounds(pts: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function projectPoly(poly: Point[], ax: number, ay: number): [min: number, max: number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of poly) {
    const p = x * ax + y * ay;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

/** True when two convex polygons overlap with positive area (touching edges do not overlap). */
export function polyIntersects(a: Point[], b: Point[], eps = 1e-6): boolean {
  const ba = polyBounds(a);
  const bb = polyBounds(b);
  if (ba.maxX <= bb.minX + eps || bb.maxX <= ba.minX + eps || ba.maxY <= bb.minY + eps || bb.maxY <= ba.minY + eps) {
    return false;
  }
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i]!;
      const p2 = poly[(i + 1) % poly.length]!;
      const ax = -(p2[1] - p1[1]);
      const ay = p2[0] - p1[0];
      if (ax === 0 && ay === 0) continue;
      const [minA, maxA] = projectPoly(a, ax, ay);
      const [minB, maxB] = projectPoly(b, ax, ay);
      const scale = Math.hypot(ax, ay);
      if (maxA <= minB + eps * scale || maxB <= minA + eps * scale) return false;
    }
  }
  return true;
}

function pointOnSegment(pt: Point, a: Point, b: Point, eps = 1e-5): boolean {
  const [px, py] = pt;
  const [ax, ay] = a;
  const [bx, by] = b;
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < eps * eps) return Math.hypot(apx, apy) <= eps;
  const t = (apx * abx + apy * aby) / lenSq;
  if (t < -eps || t > 1 + eps) return false;
  const cross = Math.abs(apx * aby - apy * abx) / Math.sqrt(lenSq);
  return cross <= eps;
}

/** Point-in-polygon test (inclusive of boundary within eps). */
export function pointInPolygon(pt: Point, poly: Point[], eps = 1e-5): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    if (pointOnSegment(pt, poly[i]!, poly[(i + 1) % poly.length]!, eps)) return true;
  }
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsProperlyCross(a1: Point, a2: Point, b1: Point, b2: Point, eps = 1e-5): boolean {
  const orient = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))
    && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** True if all vertices (and edge midpoints) of `inner` lie inside `board` without crossing outside edges. */
export function polyInsideBoard(inner: Point[], board: Point[], eps = 1e-5): boolean {
  if (board.length < 3) return true;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]!;
    const b = inner[(i + 1) % inner.length]!;
    if (!pointInPolygon(a, board, eps)) return false;
    if (!pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], board, eps)) return false;
    for (let j = 0; j < board.length; j++) {
      if (segmentsProperlyCross(a, b, board[j]!, board[(j + 1) % board.length]!, eps)) return false;
    }
  }
  return true;
}

/** Auto-compute a rectangular board outline [0,0]..[W,H] comfortably fitting the given footprints. */
export function autoBoardOutline(footprints: Footprint[]): Point[] {
  if (footprints.length === 0) return [[0, 0], [40, 0], [40, 30], [0, 30]];
  let area = 0;
  let maxW = 0;
  let maxH = 0;
  for (const fp of footprints) {
    area += fp.courtyard[0] * fp.courtyard[1];
    maxW = Math.max(maxW, fp.courtyard[0]);
    maxH = Math.max(maxH, fp.courtyard[1]);
  }
  const targetArea = Math.max(area * 2.4, (maxW + 10) * (maxH + 10));
  const rawW = Math.max(maxW + 10, Math.sqrt(targetArea * 1.35));
  const rawH = Math.max(maxH + 10, targetArea / rawW);
  const snap5 = (v: number) => Math.max(20, Math.ceil(v / 5) * 5);
  const w = snap5(rawW);
  const h = snap5(rawH);
  return [[0, 0], [w, 0], [w, h], [0, h]];
}
