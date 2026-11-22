// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef } from '@cadllm/core';
import type { Footprint } from '../types.ts';
import { generateFootprint, KNOWN_FOOTPRINT_NAMES } from './generators.ts';

/** True if this part belongs on a PCB (excludes breadboards and footprintless symbols). */
export function isPcbPart(part: PartDef): boolean {
  if (part.views?.pcb === 'none') return false;
  if (part.views?.bb === 'breadboard') return false;
  if (part.category === 'symbol' || !part.footprints?.length) return false;
  return true;
}

/** Footprint name for a placed component: `props.footprint` if set, else the part's first footprint. */
export function componentFootprintName(part: PartDef, comp: Component): string | undefined {
  if (!isPcbPart(part)) return undefined;
  return comp.props.footprint ?? part.footprints?.[0];
}

/** Generate a parametric footprint by name (e.g. "DIP-14", "0805", "THT-axial"). */
export function footprint(name: string): Footprint {
  return generateFootprint(name);
}

/** List built-in parametric footprint names. */
export function footprintNames(): readonly string[] {
  return KNOWN_FOOTPRINT_NAMES;
}

/** Local courtyard bounds [minX, minY, maxX, maxY] relative to footprint origin (0,0). */
export function footprintCourtyardBounds(fp: Footprint): { minX: number; minY: number; maxX: number; maxY: number } {
  if (fp.courtyardBounds) return fp.courtyardBounds;
  const hw = fp.courtyard[0] / 2;
  const hh = fp.courtyard[1] / 2;
  return {
    minX: fp.origin[0] - hw,
    minY: fp.origin[1] - hh,
    maxX: fp.origin[0] + hw,
    maxY: fp.origin[1] + hh,
  };
}
