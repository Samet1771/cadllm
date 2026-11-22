// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, Query } from '@cadllm/core';
import { UNIT, type Pt } from '../types.ts';

export const MAIN_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;
export const TOP_ROWS = ['A', 'B', 'C', 'D', 'E'] as const;
export const BOT_ROWS = ['F', 'G', 'H', 'I', 'J'] as const;
export const RAIL_ROWS = ['T+', 'T-', 'B+', 'B-'] as const;
export const ALL_ROWS = [...RAIL_ROWS, ...MAIN_ROWS] as const;

export type MainRow = (typeof MAIN_ROWS)[number];
export type RailRow = (typeof RAIL_ROWS)[number];
export type BoardRow = (typeof ALL_ROWS)[number];

/** Row Y coordinates in hole pitches (0.1 in) relative to board top-left. Note 0.3 in (3 pitches) between E and F. */
export const ROW_PITCH_Y: Record<BoardRow, number> = {
  'T+': 1.5,
  'T-': 2.5,
  A: 4.5,
  B: 5.5,
  C: 6.5,
  D: 7.5,
  E: 8.5,
  F: 11.5,
  G: 12.5,
  H: 13.5,
  I: 14.5,
  J: 15.5,
  'B+': 17.5,
  'B-': 18.5,
};

export const BOARD_HEIGHT_PITCHES = 20;

export interface BoardSpec {
  kind: 'half' | 'full';
  cols: number;
  comp?: Component;
  width: number;
  height: number;
}

export interface ParsedHole {
  row: BoardRow;
  col: number;
  name: string;
}

export interface StripInfo {
  id: string;
  label: string;
  kind: 'strip' | 'rail';
  col?: number;
  half?: 'T' | 'B';
  rail?: RailRow;
}

const HOLE_RE = /^([TB][+-]|[A-J])(\d+)$/i;

export function resolveBoard(q: Query): BoardSpec {
  const comps = q.components();
  const found = comps.find(c => {
    if (c.part === 'breadboard_full' || c.part === 'breadboard_half') return true;
    return q.parts.get(c.part)?.views?.bb === 'breadboard';
  });
  const isFull = found?.part === 'breadboard_full' || (found ? q.parts.get(found.part)?.pins.some(p => p.id === 'A63') : false);
  const kind: 'half' | 'full' = isFull ? 'full' : 'half';
  const cols = kind === 'full' ? 63 : 30;
  return {
    kind,
    cols,
    ...(found ? { comp: found } : {}),
    width: (cols + 3) * UNIT,
    height: BOARD_HEIGHT_PITCHES * UNIT,
  };
}

export function parseHole(raw: string): ParsedHole | undefined {
  const m = raw.trim().match(HOLE_RE);
  if (!m) return undefined;
  const row = m[1]!.toUpperCase() as BoardRow;
  const col = Number(m[2]);
  if (!Number.isInteger(col) || col < 1) return undefined;
  return { row, col, name: `${row}${col}` };
}

export function isMainRow(row: BoardRow): row is MainRow {
  return row.length === 1;
}

export function isRailRow(row: BoardRow): row is RailRow {
  return row.length === 2;
}

export function isHoleOnBoard(board: BoardSpec, hole: ParsedHole): boolean {
  return hole.col >= 1 && hole.col <= board.cols;
}

export function colToX(col: number): number {
  return (col + 1) * UNIT;
}

export function holePt(hole: ParsedHole): Pt {
  return { x: colToX(hole.col), y: ROW_PITCH_Y[hole.row] * UNIT };
}

export function holePosOnBoard(board: BoardSpec, hole: string): Pt | undefined {
  const parsed = parseHole(hole);
  if (!parsed || !isHoleOnBoard(board, parsed)) return undefined;
  return holePt(parsed);
}

export function holeAtOnBoard(board: BoardSpec, pt: Pt): string | undefined {
  const col = Math.round(pt.x / UNIT - 1);
  if (col < 1 || col > board.cols) return undefined;
  let bestRow: BoardRow | undefined;
  let bestDy = Infinity;
  for (const row of ALL_ROWS) {
    const dy = Math.abs(pt.y - ROW_PITCH_Y[row] * UNIT);
    if (dy < bestDy) {
      bestDy = dy;
      bestRow = row;
    }
  }
  if (!bestRow) return undefined;
  const hx = colToX(col);
  const hy = ROW_PITCH_Y[bestRow] * UNIT;
  if (Math.hypot(pt.x - hx, pt.y - hy) > 0.5 * UNIT) return undefined;
  return `${bestRow}${col}`;
}

export function stripOfHole(hole: ParsedHole): StripInfo {
  if (isRailRow(hole.row)) {
    return { id: `rail:${hole.row}`, label: hole.row, kind: 'rail', rail: hole.row };
  }
  const half: 'T' | 'B' = hole.row <= 'E' ? 'T' : 'B';
  return {
    id: `strip:${half}:${hole.col}`,
    label: half === 'T' ? `A${hole.col}-E${hole.col}` : `F${hole.col}-J${hole.col}`,
    kind: 'strip',
    col: hole.col,
    half,
  };
}

export function holesInStrip(board: BoardSpec, stripId: string): string[] {
  if (stripId.startsWith('rail:')) {
    const rail = stripId.slice(5);
    const out: string[] = [];
    for (let c = 1; c <= board.cols; c++) out.push(`${rail}${c}`);
    return out;
  }
  const parts = stripId.split(':');
  const half = parts[1];
  const col = Number(parts[2]);
  const rows = half === 'T' ? TOP_ROWS : BOT_ROWS;
  return rows.map(r => `${r}${col}`);
}

export function allBoardHoles(board: BoardSpec): string[] {
  const holes: string[] = [];
  for (const r of ALL_ROWS) {
    for (let c = 1; c <= board.cols; c++) holes.push(`${r}${c}`);
  }
  return holes;
}

/** SVG position of a hole ("E10", "T+3") on the circuit's breadboard. */
export function bbHolePos(q: Query, hole: string): Pt | undefined {
  return holePosOnBoard(resolveBoard(q), hole);
}

/** Nearest hole to an SVG point, if within half a pitch. For UI drag/drop snapping. */
export function bbHoleAt(q: Query, pt: Pt): string | undefined {
  return holeAtOnBoard(resolveBoard(q), pt);
}
