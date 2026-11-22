// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PcbBoard, PcbLayer, PcbRules, PcbTrack, PcbVia, Query } from '@cadllm/core';

export type Point = [x: number, y: number];
export type PcbSide = 'top' | 'bottom';
export type PadShape = 'circle' | 'rect' | 'oval' | 'roundrect';
export type PadLayers = 'TH' | 'F' | 'B';

export interface PadDef {
  /** Physical pin id matching PinDef.id (e.g. "1", "2", "D13"). */
  id: string;
  shape: PadShape;
  /** Local coordinates in mm relative to footprint origin (+x right, +y down). */
  at: Point;
  /** Outer copper size [width, height] in mm. */
  size: [w: number, h: number];
  /** Finished hole diameter in mm (for 'TH' pads). */
  drill?: number;
  layers: PadLayers;
  /** Optional corner radius ratio for 'roundrect' (default 0.25 of min(w, h)). */
  roundRadius?: number;
}

export type SilkShape =
  | { kind: 'line'; from: Point; to: Point; width?: number }
  | { kind: 'rect'; at: Point; size: [w: number, h: number]; width?: number }
  | { kind: 'circle'; at: Point; r: number; width?: number }
  | { kind: 'arc'; at: Point; r: number; startDeg: number; endDeg: number; width?: number }
  | { kind: 'poly'; points: Point[]; closed?: boolean; width?: number };

export interface Footprint {
  name: string;
  pads: PadDef[];
  silk: SilkShape[];
  /** Courtyard bounding box [width, height] in mm. */
  courtyard: [w: number, h: number];
  /** Local origin offset [x, y] in mm. */
  origin: Point;
  /** Optional explicit courtyard bounds relative to origin when asymmetric. */
  courtyardBounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface PcbPlace {
  x: number;
  y: number;
  rot: number;
  side: PcbSide;
}

export type Board = PcbBoard;
export type Rules = PcbRules;

export interface PadInstance {
  ref: string;
  compId: string;
  pinId: string;
  pinLabel: string;
  netId?: string;
  net?: string;
  shape: PadShape;
  /** World coordinates [x, y] in mm. */
  at: Point;
  size: [w: number, h: number];
  rot: number;
  drill?: number;
  layers: PadLayers;
  roundRadius?: number;
}

export interface Connection {
  netId: string;
  net: string;
  from: Point;
  to: Point;
  fromPin?: string;
  toPin?: string;
}

export interface Ratsnest {
  connections: Connection[];
  count: number;
}

export type DrcIssueCode =
  | 'unrouted'
  | 'clearance'
  | 'track_width'
  | 'drill'
  | 'short'
  | 'off_board'
  | 'overlap'
  | 'bad_place'
  | 'unplaced';

export interface DrcIssue {
  level: 'error' | 'warn';
  code: DrcIssueCode;
  message: string;
  at: string[];
}

export interface ConnectOptions {
  /** Pre-resolved pad instances (defaults to `pads(q)`). */
  pads?: PadInstance[];
}

export interface DrcOptions {
  /** Pre-resolved pad instances (defaults to `pads(q)`). */
  pads?: PadInstance[];
  /** Pre-resolved footprints keyed by footprint name (defaults to `footprint(name)`). */
  footprints?: Record<string, Footprint>;
}

export interface RouteOptions {
  /** Only route these net names (default: all unrouted nets). */
  nets?: string[];
  /** Clear and reroute selected nets from scratch. */
  reroute?: boolean;
  /** Grid resolution in mm. */
  grid?: number;
  /** Pre-resolved pad instances (defaults to `pads(q)`). */
  pads?: PadInstance[];
}

export interface RouteResult {
  tracks: PcbTrack[];
  vias: PcbVia[];
  unrouted: string[];
  notes: string[];
}

export type PcbRenderLayer = 'F' | 'B' | 'silk' | 'outline' | 'ratsnest' | 'courtyard';

export interface PcbRenderOptions {
  highlight?: string[];
  select?: string[];
  theme?: 'light' | 'dark';
  labels?: boolean;
  layers?: PcbRenderLayer[];
  state?: {
    nets?: Record<string, '0' | '1' | 'X' | 'Z' | number>;
    parts?: Record<string, { on?: boolean; level?: number }>;
  };
}

export interface PcbPlaceOptions {
  refs?: string[];
  all?: boolean;
}

export interface PcbPlaceResult {
  place: Record<string, string>;
  notes: string[];
}

export interface PcbView {
  id: 'pcb';
  render(q: Query, opts?: PcbRenderOptions): string;
  autoPlace(q: Query, opts?: PcbPlaceOptions): PcbPlaceResult;
  check(q: Query): DrcIssue[];
}

export type { PcbLayer, PcbTrack, PcbVia };
