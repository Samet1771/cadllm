// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildInductor(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const p1 = findPin(part.pins, ['1'], 0);
  const p2 = findPin(part.pins, ['2'], 1);
  const pins = [
    ...(p1 ? [{ pin: p1, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(p2 ? [{ pin: p2, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const d = path([
    'M', -20, 0, 'L', -12, 0,
    'A', 3, 4.5, 0, 0, 1, -6, 0,
    'A', 3, 4.5, 0, 0, 1, 0, 0,
    'A', 3, 4.5, 0, 0, 1, 6, 0,
    'A', 3, 4.5, 0, 0, 1, 12, 0,
    'L', 20, 0,
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'inductor',
    body: [el('path', { d, class: 'sym' })],
    pins,
    bodyBox: { minX: -1.4, minY: -0.6, maxX: 1.4, maxY: 0.6 },
    labelOffsets: { horizY: 0.85, vertX: 0.85 },
  });
}
