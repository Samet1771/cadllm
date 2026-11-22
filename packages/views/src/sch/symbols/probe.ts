// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildProbe(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pin = findPin(part.pins, ['IN', '1'], 0);
  const pins = pin ? [{ pin, lx: -1, ly: 0, dir: 'L' as const }] : [];
  const d = path([
    'M', -10, 0, 'L', 0, 0,
    'M', 0, 0, 'L', 5, -6, 'L', 17, -6, 'L', 17, 6, 'L', 5, 6, 'Z',
  ]);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'probe',
    body: [el('path', { d, class: 'sym' })],
    pins,
    bodyBox: { minX: -0.2, minY: -0.7, maxX: 1.8, maxY: 0.7 },
    labelOffsets: { forceSide: 'above', horizY: 1.1, vertX: 1.2 },
    marks: [{ text: 'P', lx: 1.0, ly: 0 }],
  });
}
