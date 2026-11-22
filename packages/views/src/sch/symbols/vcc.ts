// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Component, type PartDef, type Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import { UNIT } from '../../types.ts';
import { transformBox, transformDir, transformLocalPt } from '../place.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { findPin, svgTransform } from './common.ts';

export function buildVcc(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const pin = findPin(part.pins, ['VCC', '1'], 0);
  const key = pin ? pinKey(comp.id, pin.id) : `${comp.id}:1`;
  const netName = q.netOfPin(key)?.name ?? comp.props['voltage'] ?? 'VCC';
  const pt = transformLocalPt({ x: 0, y: 0 }, place);
  const dir = transformDir('D', place);
  const placedPins = pin
    ? [{ pin, key, label: q.pinLabel(key), gx: pt.x, gy: pt.y, dir }]
    : [];

  const d = path(['M', 0, 0, 'L', 0, -10, 'M', -7, -10, 'L', 7, -10]);
  const lblPt = transformLocalPt({ x: 0, y: -1.4 }, place);
  const bodyBox = transformBox({ minX: -0.8, minY: -1.4, maxX: 0.8, maxY: -0.1 }, place);

  return {
    comp,
    part,
    family: 'vcc',
    place,
    pins: placedPins,
    bodyBox,
    blockedCells: [],
    fullBox: {
      minX: Math.min(bodyBox.minX, pt.x, lblPt.x - 1),
      minY: Math.min(bodyBox.minY, pt.y, lblPt.y - 0.6),
      maxX: Math.max(bodyBox.maxX, pt.x, lblPt.x + 1),
      maxY: Math.max(bodyBox.maxY, pt.y, lblPt.y + 0.4),
    },
    bodySvg: [
      el('g', { transform: svgTransform(place) }, [el('path', { d, class: 'pwr-sym' })]),
      el('text', {
        x: lblPt.x * UNIT,
        y: lblPt.y * UNIT,
        'text-anchor': 'middle',
        class: 'pwr-lbl',
      }, netName),
    ],
    labels: [],
  };
}
