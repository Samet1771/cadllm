// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { View } from '../types.ts';
import { autoPlaceSchematic } from './autoplace.ts';
import { checkSchematic } from './check.ts';
import { renderSchematic } from './render.ts';

export { parseSchPlace, formatSchPlace } from './place.ts';
export { buildSymbol } from './symbols/index.ts';
export type { SchPlace, PlacedSymbol, PlacedPin, Dir, GridBox } from './types.ts';

/** Schematic view: ANSI/IEEE symbols, A* derived orthogonal routing, signal-flow autoPlace. */
export const schematic: View = {
  id: 'sch',
  render: renderSchematic,
  autoPlace: autoPlaceSchematic,
  check: checkSchematic,
};
