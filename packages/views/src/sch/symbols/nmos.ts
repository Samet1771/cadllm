// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildNmos(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pg = findPin(part.pins, ['G', 'gate', '2'], 1);
  const pd = findPin(part.pins, ['D', 'drain', '3'], 2);
  const ps = findPin(part.pins, ['S', 'source', '1'], 0);
  const pins = [
    ...(pg ? [{ pin: pg, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pd ? [{ pin: pd, lx: 1, ly: -2, dir: 'U' as const }] : []),
    ...(ps ? [{ pin: ps, lx: 1, ly: 2, dir: 'D' as const }] : []),
  ];
  const lines = path([
    'M', -20, 0, 'L', -7, 0,
    'M', -7, -8, 'L', -7, 8,
    'M', -3, -9, 'L', -3, -4,
    'M', -3, -2.5, 'L', -3, 2.5,
    'M', -3, 4, 'L', -3, 9,
    'M', -3, -6.5, 'L', 10, -6.5, 'L', 10, -20,
    'M', -3, 6.5, 'L', 10, 6.5, 'L', 10, 20,
    'M', -3, 0, 'L', 10, 0, 'L', 10, 6.5,
  ]);
  const arrow = path(['M', -2, 0, 'L', 3, -2.5, 'L', 3, 2.5, 'Z']);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'nmos',
    body: [
      el('circle', { cx: 0, cy: 0, r: 12, class: 'sym' }),
      el('path', { d: lines, class: 'sym' }),
      el('path', { d: arrow, class: 'sym-fill' }),
    ],
    pins,
    bodyBox: { minX: -1.2, minY: -1.2, maxX: 1.2, maxY: 1.2 },
    labelOffsets: { forceSide: 'right', vertX: 1.5 },
  });
}
