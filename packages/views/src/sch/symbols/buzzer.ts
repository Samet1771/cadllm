// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildBuzzer(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pp = findPin(part.pins, ['+', 'pos', '1'], 0);
  const pn = findPin(part.pins, ['-', 'neg', '2'], 1);
  const pins = [
    ...(pp ? [{ pin: pp, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pn ? [{ pin: pn, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const leads = path(['M', -20, 0, 'L', -10, 0, 'M', 10, 0, 'L', 20, 0]);
  const dome = path(['M', -10, 0, 'L', -10, -4, 'A', 10, 10, 0, 0, 1, 10, -4, 'L', 10, 0, 'Z']);
  const base = path(['M', -6, 0, 'L', -6, 5, 'L', 6, 5, 'L', 6, 0]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'buzzer',
    body: [
      el('path', { d: leads, class: 'sym' }),
      el('path', { d: dome, class: 'sym' }),
      el('path', { d: base, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.2, minY: -1.4, maxX: 1.2, maxY: 0.7 },
    labelOffsets: { forceSide: 'below', horizY: 1.3, vertX: 1.3 },
    marks: [{ text: '+', lx: -1.3, ly: -0.5 }],
  });
}
