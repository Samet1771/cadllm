// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildNpn(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pb = findPin(part.pins, ['B', 'base', '2'], 1);
  const pc = findPin(part.pins, ['C', 'collector', '3'], 2);
  const pe = findPin(part.pins, ['E', 'emitter', '1'], 0);
  const pins = [
    ...(pb ? [{ pin: pb, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pc ? [{ pin: pc, lx: 1, ly: -2, dir: 'U' as const }] : []),
    ...(pe ? [{ pin: pe, lx: 1, ly: 2, dir: 'D' as const }] : []),
  ];
  const lines = path([
    'M', -20, 0, 'L', -5, 0,
    'M', -5, -8, 'L', -5, 8,
    'M', -5, -4, 'L', 10, -12, 'L', 10, -20,
    'M', -5, 4, 'L', 10, 12, 'L', 10, 20,
  ]);
  const arrow = path(['M', 4, 11.5, 'L', 9.5, 11.8, 'L', 6.5, 7, 'Z']);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'npn',
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
