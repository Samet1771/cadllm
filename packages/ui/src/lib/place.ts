// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { UNIT, type Pt, type ViewId } from '@cadllm/views';

export type Rotation = 0 | 90 | 180 | 270;

export interface SchPlace {
  x: number;
  y: number;
  rot: Rotation;
  mirror: boolean;
}

const VALID_ROT = new Set<number>([0, 90, 180, 270]);
const ROWS = 'ABCDEFGHIJ';
const MAX_COL = 64;

const zeroSafe = (n: number): number => (Object.is(n, -0) ? 0 : n);

/** Parse schematic place string `x,y[,rot][,m]`. Returns undefined when invalid. */
export function parseSchPlace(raw: string | undefined): SchPlace | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length < 2 || parts.length > 4) return undefined;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;

  let rot: Rotation = 0;
  let mirror = false;

  if (parts.length === 3) {
    if (parts[2] === 'm') {
      mirror = true;
    } else {
      const r = Number(parts[2]);
      if (!VALID_ROT.has(r)) return undefined;
      rot = r as Rotation;
    }
  } else if (parts.length === 4) {
    const r = Number(parts[2]);
    if (!VALID_ROT.has(r) || parts[3] !== 'm') return undefined;
    rot = r as Rotation;
    mirror = true;
  }

  return { x: zeroSafe(x), y: zeroSafe(y), rot, mirror };
}

/** Format a schematic place struct into canonical CNL `x,y[,rot][,m]`. */
export function formatSchPlace(p: SchPlace): string {
  const x = zeroSafe(Math.round(p.x));
  const y = zeroSafe(Math.round(p.y));
  const rot = normalizeRotation(p.rot);
  if (p.mirror) return `${x},${y},${rot},m`;
  if (rot !== 0) return `${x},${y},${rot}`;
  return `${x},${y}`;
}

export function normalizeRotation(deg: number): Rotation {
  const n = ((Math.round(deg) % 360) + 360) % 360;
  if (n === 90 || n === 180 || n === 270) return n;
  return 0;
}

/** Rotate a schematic place string clockwise by `step` degrees (default 90). */
export function rotateSchPlace(raw: string | undefined, step = 90): string {
  const cur = parseSchPlace(raw) ?? { x: 0, y: 0, rot: 0, mirror: false };
  return formatSchPlace({ ...cur, rot: normalizeRotation(cur.rot + step) });
}

/** Shift an existing schematic placement by grid delta, or place at `fallbackGrid` if unplaced/invalid. */
export function moveSchPlace(raw: string | undefined, dx: number, dy: number, fallbackGrid: Pt): string {
  const cur = parseSchPlace(raw);
  if (cur) {
    return formatSchPlace({
      ...cur,
      x: cur.x + Math.round(dx),
      y: cur.y + Math.round(dy),
    });
  }
  return formatSchPlace({
    x: Math.round(fallbackGrid.x),
    y: Math.round(fallbackGrid.y),
    rot: 0,
    mirror: false,
  });
}

/** Snap SVG user-space coordinates to integer grid steps. */
export function snapToGrid(svgPt: Pt, unit = UNIT): Pt {
  return {
    x: zeroSafe(Math.round(svgPt.x / unit)),
    y: zeroSafe(Math.round(svgPt.y / unit)),
  };
}

/** Parse simple `x,y` grid coordinates (e.g. off-board breadboard placement). */
export function parseGridPlace(raw: string | undefined): Pt | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length !== 2) return undefined;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: zeroSafe(Math.round(x)), y: zeroSafe(Math.round(y)) };
}

export function formatGridPlace(pt: Pt): string {
  return `${zeroSafe(Math.round(pt.x))},${zeroSafe(Math.round(pt.y))}`;
}

export interface BbHoleCoord {
  row: number;
  col: number;
}

/** Parse a breadboard main-grid hole name (`A1`..`J64`). Returns undefined for rails or invalid names. */
export function parseBbHole(hole: string): BbHoleCoord | undefined {
  const m = hole.trim().toUpperCase().match(/^([A-J])(\d+)$/);
  if (!m) return undefined;
  const row = ROWS.indexOf(m[1]!);
  const col = Number(m[2]);
  if (row < 0 || !Number.isInteger(col) || col < 1 || col > MAX_COL) return undefined;
  return { row, col };
}

export function formatBbHole(coord: BbHoleCoord, maxCol = MAX_COL): string | undefined {
  const letter = ROWS[coord.row];
  if (!letter || !Number.isInteger(coord.col) || coord.col < 1 || coord.col > maxCol) return undefined;
  return `${letter}${coord.col}`;
}

/**
 * Compute new breadboard placement on drop. Preserves 2-pin span (`E10-E14`) when both
 * start and target holes are main-grid holes and the shifted span stays on the grid.
 */
export function shiftBbPlace(
  prevPlace: string | undefined,
  fromHole: string | undefined,
  toHole: string,
  maxCol = MAX_COL,
): string {
  if (prevPlace && prevPlace.includes('-') && fromHole) {
    const [aRaw, bRaw] = prevPlace.split('-');
    const a = aRaw ? parseBbHole(aRaw) : undefined;
    const b = bRaw ? parseBbHole(bRaw) : undefined;
    const from = parseBbHole(fromHole);
    const to = parseBbHole(toHole);
    if (a && b && from && to) {
      const dRow = to.row - from.row;
      const dCol = to.col - from.col;
      const nextA = formatBbHole({ row: a.row + dRow, col: a.col + dCol }, maxCol);
      const nextB = formatBbHole({ row: b.row + dRow, col: b.col + dCol }, maxCol);
      if (nextA && nextB) return `${nextA}-${nextB}`;
    }
  }
  return toHole;
}

/** Next unused component ref for a prefix (`R1`, `R2`, ...), case-insensitive. */
export function nextAutoRef(prefix: string, existingRefs: Iterable<string>): string {
  const used = new Set<string>();
  for (const r of existingRefs) used.add(r.toUpperCase());
  const base = prefix || 'X';
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!used.has(candidate.toUpperCase())) return candidate;
  }
}

/** Next unused auto net name (`N1`, `N2`, ...), case-insensitive. */
export function nextAutoNetName(existingNets: Iterable<string>): string {
  const used = new Set<string>();
  for (const n of existingNets) used.add(n.toUpperCase());
  for (let i = 1; ; i++) {
    const candidate = `N${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Format a single-component placement edit line. */
export function formatPlaceEdit(ref: string, view: ViewId, place: string): string {
  return `${ref} @${view}:${place}`;
}

/**
 * Build a CNL connect line between two pins (`R1.2`, `D1.A`).
 * Reuses pinA's existing net if it has one; otherwise creates a fresh `N<k>` net.
 */
export function buildConnectCnl(q: Query, pinA: string, pinB: string): string | undefined {
  const resolvedA = q.resolvePin(pinA);
  const resolvedB = q.resolvePin(pinB);
  if (resolvedA.key === resolvedB.key) return undefined;
  const existing = q.netOfPin(resolvedA.key);
  const netName = existing ? existing.name : nextAutoNetName(q.nets().map(n => n.name));
  return `${netName}: ${pinA} ${pinB}`;
}
