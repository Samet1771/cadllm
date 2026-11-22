// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildLed(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pa = findPin(part.pins, ['A', 'anode', '+', '1'], 0);
  const pk = findPin(part.pins, ['K', 'cathode', '-', '2'], 1);
  const pins = [
    ...(pa ? [{ pin: pa, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pk ? [{ pin: pk, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const leads = path(['M', -20, 0, 'L', -6, 0, 'M', 6, 0, 'L', 20, 0]);
  const tri = path(['M', -6, -7, 'L', 6, 0, 'L', -6, 7, 'Z']);
  const bar = path(['M', 6, -7, 'L', 6, 7]);
  const rays = path([
    'M', -2, -9, 'L', 4, -15,
    'M', 1.5, -15, 'L', 4, -15, 'L', 4, -12.5,
    'M', 3, -8, 'L', 9, -14,
    'M', 6.5, -14, 'L', 9, -14, 'L', 9, -11.5,
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'led',
    body: [
      el('path', { d: leads, class: 'sym' }),
      el('path', { d: tri, class: 'sym' }),
      el('path', { d: bar, class: 'sym' }),
      el('path', { d: rays, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.2, minY: -1.3, maxX: 1.2, maxY: 0.8 },
    labelOffsets: { forceSide: 'below', horizY: 1.6, vertX: 1.3 },
  });
}
