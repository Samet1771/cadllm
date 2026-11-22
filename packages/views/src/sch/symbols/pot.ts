// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildDiscreteSymbol, findPin } from './common.ts';

export function buildPot(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const p1 = findPin(part.pins, ['1'], 0);
  const pw = findPin(part.pins, ['W', 'wiper', '2'], 1);
  const p3 = findPin(part.pins, ['3'], 2);
  const pins = [
    ...(p1 ? [{ pin: p1, lx: -2, ly: 0, dir: 'L' as const }] : []),
    ...(pw ? [{ pin: pw, lx: 0, ly: -2, dir: 'U' as const }] : []),
    ...(p3 ? [{ pin: p3, lx: 2, ly: 0, dir: 'R' as const }] : []),
  ];
  const resistorPath = path([
    'M', -20, 0, 'L', -12, 0,
    'L', -10, -4.5, 'L', -6, 4.5, 'L', -2, -4.5, 'L', 2, 4.5, 'L', 6, -4.5, 'L', 10, 4.5,
    'L', 12, 0, 'L', 20, 0,
  ]);
  const wiperPath = path(['M', 0, -20, 'L', 0, -6.5]);
  const arrowPath = path(['M', -2.5, -9, 'L', 0, -5, 'L', 2.5, -9, 'Z']);
  return buildDiscreteSymbol(q, comp, part, place, {
    family: 'pot',
    body: [
      el('path', { d: resistorPath, class: 'sym' }),
      el('path', { d: wiperPath, class: 'sym' }),
      el('path', { d: arrowPath, class: 'sym-fill' }),
    ],
    pins,
    bodyBox: { minX: -1.4, minY: -1.2, maxX: 1.4, maxY: 0.6 },
    labelOffsets: { forceSide: 'below', horizY: 1.2, vertX: 1.1 },
  });
}
