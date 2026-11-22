// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import type { Pt, View } from '../types.ts';

/** Breadboard view (WP2). Placeholder until implemented. */
export const breadboard: View = {
  id: 'bb',
  render: () => { throw new Error('breadboard render: not implemented'); },
  autoPlace: () => { throw new Error('breadboard autoPlace: not implemented'); },
  check: () => [],
};

/** SVG position of a hole ("E10", "T+3") on the circuit's breadboard. */
export function bbHolePos(_q: Query, _hole: string): Pt | undefined {
  throw new Error('bbHolePos: not implemented');
}

/** Nearest hole to an SVG point, if within half a pitch. For UI drag/drop snapping. */
export function bbHoleAt(_q: Query, _pt: Pt): string | undefined {
  throw new Error('bbHoleAt: not implemented');
}
