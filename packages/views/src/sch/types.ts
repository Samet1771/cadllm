// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, PinDef, PinKey } from '@cadllm/core';

export type Dir = 'L' | 'R' | 'U' | 'D';

export interface SchPlace {
  x: number;
  y: number;
  rot: 0 | 90 | 180 | 270;
  mirror: boolean;
}

export interface GridBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlacedPin {
  pin: PinDef;
  key: PinKey;
  label: string;
  /** World grid X (integer). */
  gx: number;
  /** World grid Y (integer). */
  gy: number;
  /** Outward direction from symbol in world coordinates. */
  dir: Dir;
}

export interface LabelSpec {
  text: string;
  /** World SVG coordinates. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  kind: 'ref' | 'val';
}

export interface PlacedSymbol {
  comp: Component;
  part: PartDef;
  family: string;
  place: SchPlace;
  pins: PlacedPin[];
  /** Body bounding box in world grid units (used for overlap & routing obstacles). */
  bodyBox: GridBox;
  /** Integer grid cells blocked by this symbol body (excluding pin anchors). */
  blockedCells: { gx: number; gy: number }[];
  /** Full bounding box in world grid units including pins & labels (used for viewBox). */
  fullBox: GridBox;
  /** Raw SVG elements inside <g data-ref="..."> (geometry + optional labels). */
  bodySvg: string[];
  labels: LabelSpec[];
}
