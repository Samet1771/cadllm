// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildBattery(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pp = findPin(part.pins, ['+', 'pos', '1'], 0);
  const pn = findPin(part.pins, ['-', 'neg', '2'], 1);
  const pins = [
    ...(pp ? [{ pin: pp, lx: 0, ly: -2, dir: 'U' as const }] : []),
    ...(pn ? [{ pin: pn, lx: 0, ly: 2, dir: 'D' as const }] : []),
  ];
  const d = path([
    'M', 0, -20, 'L', 0, -6,
    'M', -10, -6, 'L', 10, -6,
    'M', -5, -2, 'L', 5, -2,
    'M', -10, 2, 'L', 10, 2,
    'M', -5, 6, 'L', 5, 6,
    'M', 0, 6, 'L', 0, 20,
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'battery',
    body: [el('path', { d, class: 'sym' })],
    pins,
    bodyBox: { minX: -1.1, minY: -1.2, maxX: 1.1, maxY: 1.2 },
    verticalNatural: true,
    labelOffsets: { horizY: 1.35, vertX: 1.3 },
    marks: [{ text: '+', lx: -0.75, ly: -1.1 }],
  });
}
