// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Component, type PartDef, type Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import { UNIT } from '../../types.ts';
import { transformBox, transformDir, transformLocalPt } from '../place.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { findPin, svgTransform } from './common.ts';

export function buildGnd(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pin = findPin(part.pins, ['GND', '1'], 0);
  const key = pin ? pinKey(comp.id, pin.id) : `${comp.id}:1`;
  const netName = q.netOfPin(key)?.name ?? 'GND';
  const pt = transformLocalPt({ x: 0, y: 0 }, place);
  const dir = transformDir('U', place);
  const placedPins = pin
    ? [{ pin, key, label: q.pinLabel(key), gx: pt.x, gy: pt.y, dir }]
    : [];

  const d = path([
    'M', 0, 0, 'L', 0, 8,
    'M', -8, 8, 'L', 8, 8,
    'M', -5, 11.5, 'L', 5, 11.5,
    'M', -2, 15, 'L', 2, 15,
  ]);
  const lblPt = transformLocalPt({ x: 0, y: 2.3 }, place);
  const bodyBox = transformBox({ minX: -0.9, minY: 0.1, maxX: 0.9, maxY: 1.6 }, place);

  return {
    comp,
    part,
    family: 'gnd',
    place,
    pins: placedPins,
    bodyBox,
    blockedCells: [],
    fullBox: {
      minX: Math.min(bodyBox.minX, pt.x, lblPt.x - 1),
      minY: Math.min(bodyBox.minY, pt.y, lblPt.y - 0.5),
      maxX: Math.max(bodyBox.maxX, pt.x, lblPt.x + 1),
      maxY: Math.max(bodyBox.maxY, pt.y, lblPt.y + 0.4),
    },
    bodySvg: [
      el('g', { transform: svgTransform(place) }, [el('path', { d, class: 'gnd-sym' })]),
      el('text', {
        x: lblPt.x * UNIT,
        y: lblPt.y * UNIT,
        'text-anchor': 'middle',
        class: 'gnd-lbl',
      }, netName),
    ],
    labels: [],
  };
}
