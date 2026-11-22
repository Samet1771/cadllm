// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';

export type ViewId = 'sch' | 'bb';

export interface Pt {
  x: number;
  y: number;
}

/**
 * Drawing units. 1 schematic grid step = 1 breadboard hole pitch (0.1 in) = UNIT user units in the SVG.
 * Place strings use grid steps / hole names, never SVG units.
 */
export const UNIT = 10;

export interface RenderOptions {
  /** Refs or "net:NAME" to emphasize, e.g. what another client just changed. */
  highlight?: string[];
  /** Crop the drawing to these refs (plus a margin). Default: everything. */
  select?: string[];
  theme?: 'light' | 'dark';
  /** Ref/value text next to parts. Default true. */
  labels?: boolean;
}

export type ViewIssueCode =
  | 'unplaced'       // warn: component has no position in this view (it is not drawn)
  | 'bad_place'      // error: place string can't be parsed or doesn't fit the part
  | 'overlap'        // warn (sch) / error (bb): two parts occupy the same cells/holes
  | 'off_board'      // error (bb): a pin lands outside the breadboard
  | 'bb_short'       // error (bb): pins of different nets share one strip or rail
  | 'strip_full';    // warn (bb): no free hole left in a strip for a jumper

export interface ViewIssue {
  level: 'error' | 'warn';
  code: ViewIssueCode;
  message: string;
  /** Refs, pin labels (R1.2), net names or holes (E10) involved. */
  at: string[];
}

export interface PlaceResult {
  /** New place strings by ref, e.g. { U1: "E10", R1: "F20-F24" } or { R1: "12,4,90" }. */
  place: Record<string, string>;
  notes: string[];
}

export interface PlaceOptions {
  /** Only place these refs. Default: every unplaced component. */
  refs?: string[];
  /** Re-place already placed components too. */
  all?: boolean;
}

/** One view: pure functions of the circuit. Same input → byte-identical output. */
export interface View {
  id: ViewId;
  /** Standalone SVG document. */
  render(q: Query, opts?: RenderOptions): string;
  /** Positions for unplaced (or all) components. The caller applies them as one edit. */
  autoPlace(q: Query, opts?: PlaceOptions): PlaceResult;
  /** View consistency checks (placement, overlaps, breadboard shorts). */
  check(q: Query): ViewIssue[];
}
