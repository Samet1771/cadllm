// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildSwitch(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const p1 = findPin(part.pins, ['1'], 0);
  const p2 = findPin(part.pins, ['2'], 1);
  const pins = [
    ...(p1 ? [{ pin: p1, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(p2 ? [{ pin: p2, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const closed = comp.props['state'] === 'closed';
  const leads = path(['M', -20, 0, 'L', -10, 0, 'M', 10, 0, 'L', 20, 0]);
  const blade = closed
    ? path(['M', -6, 0, 'L', 8, 0])
    : path(['M', -6.5, -1, 'L', 7.5, -9]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'switch',
    body: [
      el('path', { d: leads, class: 'sym' }),
      el('circle', { cx: -8, cy: 0, r: 2, class: 'sym' }),
      el('circle', { cx: 8, cy: 0, r: 2, class: 'sym' }),
      el('path', { d: blade, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.3, minY: -1.0, maxX: 1.3, maxY: 0.5 },
    labelOffsets: { horizY: 1.25, vertX: 1.0 },
  });
}
