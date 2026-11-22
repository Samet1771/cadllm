// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildButton(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const p1 = findPin(part.pins, ['1'], 0);
  const p2 = findPin(part.pins, ['2'], 1);
  const pins = [
    ...(p1 ? [{ pin: p1, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(p2 ? [{ pin: p2, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const pressed = comp.props['state'] === 'pressed';
  const barY = pressed ? -2 : -7;
  const leads = path(['M', -20, 0, 'L', -10, 0, 'M', 10, 0, 'L', 20, 0]);
  const bridge = path([
    'M', -9, barY, 'L', 9, barY,
    'M', 0, barY, 'L', 0, barY - 6,
    'M', -4, barY - 6, 'L', 4, barY - 6,
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'button',
    body: [
      el('path', { d: leads, class: 'sym' }),
      el('circle', { cx: -8, cy: 0, r: 2, class: 'sym' }),
      el('circle', { cx: 8, cy: 0, r: 2, class: 'sym' }),
      el('path', { d: bridge, class: 'sym' }),
    ],
    pins,
    bodyBox: { minX: -1.3, minY: -1.4, maxX: 1.3, maxY: 0.5 },
    labelOffsets: { forceSide: 'below', horizY: 1.25, vertX: 1.1 },
  });
}
