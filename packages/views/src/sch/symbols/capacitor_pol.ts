// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildCapacitorPol(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const p1 = findPin(part.pins, ['+', 'pos', '1'], 0);
  const p2 = findPin(part.pins, ['-', 'neg', '2'], 1);
  const pins = [
    ...(p1 ? [{ pin: p1, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(p2 ? [{ pin: p2, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const d = path([
    'M', -20, 0, 'L', -3, 0,
    'M', -3, -9, 'L', -3, 9,
    'M', 5, -9, 'Q', 0.5, 0, 5, 9,
    'M', 3, 0, 'L', 20, 0,
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'capacitor_pol',
    body: [el('path', { d, class: 'sym' })],
    pins,
    bodyBox: { minX: -1.2, minY: -0.9, maxX: 1.2, maxY: 0.9 },
    labelOffsets: { horizY: 1.25, vertX: 1.15 },
    marks: [{ text: '+', lx: -0.8, ly: -0.6 }],
  });
}
