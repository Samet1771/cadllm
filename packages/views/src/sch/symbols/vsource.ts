// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildVsource(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pp = findPin(part.pins, ['+', 'pos', '1'], 0);
  const pn = findPin(part.pins, ['-', 'neg', '2'], 1);
  const pins = [
    ...(pp ? [{ pin: pp, lx: 0, ly: -2, dir: 'U' as const }] : []),
    ...(pn ? [{ pin: pn, lx: 0, ly: 2, dir: 'D' as const }] : []),
  ];
  const leads = path(['M', 0, -20, 'L', 0, -11, 'M', 0, 11, 'L', 0, 20]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'vsource',
    body: [
      el('circle', { cx: 0, cy: 0, r: 11, class: 'sym' }),
      el('path', { d: leads, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.2, minY: -1.2, maxX: 1.2, maxY: 1.2 },
    verticalNatural: true,
    labelOffsets: { horizY: 1.45, vertX: 1.4 },
    marks: [
      { text: '+', lx: 0, ly: -0.5 },
      { text: '−', lx: 0, ly: 0.55 },
    ],
  });
}
