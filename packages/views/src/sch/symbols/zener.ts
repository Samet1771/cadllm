// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildZener(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pa = findPin(part.pins, ['A', 'anode', '+', '1'], 0);
  const pk = findPin(part.pins, ['K', 'cathode', '-', '2'], 1);
  const pins = [
    ...(pa ? [{ pin: pa, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pk ? [{ pin: pk, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const leads = path(['M', -20, 0, 'L', -6, 0, 'M', 6, 0, 'L', 20, 0]);
  const tri = path(['M', -6, -7, 'L', 6, 0, 'L', -6, 7, 'Z']);
  const bar = path(['M', 3, -9, 'L', 6, -7, 'L', 6, 7, 'L', 9, 9]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'zener',
    body: [
      el('path', { d: leads, class: 'sym' }),
      el('path', { d: tri, class: 'sym' }),
      el('path', { d: bar, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.2, minY: -0.9, maxX: 1.2, maxY: 0.9 },
    labelOffsets: { horizY: 1.2, vertX: 1.05 },
  });
}
