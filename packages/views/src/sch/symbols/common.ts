// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Component, type PartDef, type PinDef, type Query } from '@cadllm/core';
import { el, num } from '../../svg.ts';
import { UNIT } from '../../types.ts';
import { transformBox, transformDir, transformLocalPt } from '../place.ts';
import type { Dir, GridBox, LabelSpec, PlacedPin, PlacedSymbol, SchPlace } from '../types.ts';

export interface LocalPinSpec {
  pin: PinDef;
  lx: number;
  ly: number;
  dir: Dir;
}

export interface LocalMarkSpec {
  text: string;
  lx: number;
  ly: number;
  className?: string;
}

export interface DiscreteSpec {
  family: string;
  /** SVG elements in local SVG units (1 grid step = UNIT = 10). */
  body: string[];
  pins: LocalPinSpec[];
  /** Body obstacle / overlap box in local grid units. */
  bodyBox: GridBox;
  /** Whether the symbol's natural pin axis is vertical at rot=0 (like battery/vsource/vcc/gnd). */
  verticalNatural?: boolean;
  /** Custom label placement override in local grid units. */
  labelOffsets?: {
    /** Distance from origin for horizontal orientation (above/below). */
    horizY?: number;
    /** Distance from origin for vertical orientation (right side). */
    vertX?: number;
    /** Put both ref and val below (e.g. pot with top wiper) or above. */
    forceSide?: 'below' | 'above' | 'right';
  };
  marks?: LocalMarkSpec[];
}

export function svgTransform(place: SchPlace): string {
  const tx = `translate(${num(place.x * UNIT)},${num(place.y * UNIT)})`;
  const r = place.rot ? ` rotate(${place.rot})` : '';
  const m = place.mirror ? ' scale(-1,1)' : '';
  return `${tx}${r}${m}`;
}

export function valueLabel(comp: Component, part: PartDef): string | undefined {
  if (part.valueProp) {
    const v = comp.props[part.valueProp];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

export function findPin(pins: PinDef[], names: string[], fallbackIdx: number): PinDef | undefined {
  const lower = names.map(n => n.toLowerCase());
  const byId = pins.find(p => lower.includes(p.id.toLowerCase()));
  if (byId) return byId;
  const byName = pins.find(p => lower.includes(p.name.toLowerCase()));
  if (byName) return byName;
  const byAlias = pins.find(p => p.aliases?.some(a => lower.includes(a.toLowerCase())));
  if (byAlias) return byAlias;
  return pins[fallbackIdx];
}

export function buildDiscreteSymbol(
  q: Query,
  comp: Component,
  part: PartDef,
  place: SchPlace,
  spec: DiscreteSpec,
): PlacedSymbol {
  const placedPins: PlacedPin[] = spec.pins.map(sp => {
    const pt = transformLocalPt({ x: sp.lx, y: sp.ly }, place);
    const key = pinKey(comp.id, sp.pin.id);
    return {
      pin: sp.pin,
      key,
      label: q.pinLabel(key),
      gx: pt.x,
      gy: pt.y,
      dir: transformDir(sp.dir, place),
    };
  });

  const pinSet = new Set(placedPins.map(p => `${p.gx},${p.gy}`));
  const blockedCells: { gx: number; gy: number }[] = [];
  for (let lx = Math.ceil(spec.bodyBox.minX); lx <= Math.floor(spec.bodyBox.maxX); lx++) {
    for (let ly = Math.ceil(spec.bodyBox.minY); ly <= Math.floor(spec.bodyBox.maxY); ly++) {
      const pt = transformLocalPt({ x: lx, y: ly }, place);
      if (!pinSet.has(`${pt.x},${pt.y}`)) {
        blockedCells.push({ gx: pt.x, gy: pt.y });
      }
    }
  }

  const bodyBox = transformBox(spec.bodyBox, place);

  // Compute upright labels outside the rotated/mirrored geometry group.
  const labels: LabelSpec[] = [];
  const val = valueLabel(comp, part);
  const cx = place.x * UNIT;
  const cy = place.y * UNIT;
  const isVertAxis = spec.verticalNatural
    ? (place.rot === 0 || place.rot === 180)
    : (place.rot === 90 || place.rot === 270);

  const offsets = spec.labelOffsets ?? {};
  if (offsets.forceSide === 'above' || offsets.forceSide === 'below') {
    const p = transformLocalPt({ x: 0, y: offsets.forceSide === 'below' ? 1 : -1 }, place);
    const dx = p.x - place.x;
    const dy = p.y - place.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      const sign = dy >= 0 ? 1 : -1;
      const baseY = cy + sign * ((offsets.horizY ?? 1.2) * UNIT);
      labels.push({ text: comp.ref, x: cx, y: sign > 0 ? baseY : baseY - 10, anchor: 'middle', kind: 'ref' });
      if (val) labels.push({ text: val, x: cx, y: sign > 0 ? baseY + 10 : baseY, anchor: 'middle', kind: 'val' });
    } else {
      const sign = dx >= 0 ? 1 : -1;
      const lx = cx + sign * ((offsets.vertX ?? 1.2) * UNIT);
      const anchor = sign > 0 ? 'start' : 'end';
      labels.push({ text: comp.ref, x: lx, y: cy - 2, anchor, kind: 'ref' });
      if (val) labels.push({ text: val, x: lx, y: cy + 8, anchor, kind: 'val' });
    }
  } else if (offsets.forceSide === 'right') {
    const p = transformLocalPt({ x: 1, y: 0 }, place);
    const dx = p.x - place.x;
    const dy = p.y - place.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const sign = dx >= 0 ? 1 : -1;
      const lx = cx + sign * ((offsets.vertX ?? 1.5) * UNIT);
      const anchor = sign > 0 ? 'start' : 'end';
      labels.push({ text: comp.ref, x: lx, y: cy - 2, anchor, kind: 'ref' });
      if (val) labels.push({ text: val, x: lx, y: cy + 8, anchor, kind: 'val' });
    } else {
      const sign = dy >= 0 ? 1 : -1;
      const baseY = cy + sign * ((offsets.vertX ?? 1.5) * UNIT);
      labels.push({ text: comp.ref, x: cx, y: sign > 0 ? baseY : baseY - 10, anchor: 'middle', kind: 'ref' });
      if (val) labels.push({ text: val, x: cx, y: sign > 0 ? baseY + 10 : baseY, anchor: 'middle', kind: 'val' });
    }
  } else if (!isVertAxis) {
    const hy = (offsets.horizY ?? 0.9) * UNIT;
    labels.push({ text: comp.ref, x: cx, y: cy - hy, anchor: 'middle', kind: 'ref' });
    if (val) labels.push({ text: val, x: cx, y: cy + hy + 6, anchor: 'middle', kind: 'val' });
  } else {
    const vx = (offsets.vertX ?? 1.1) * UNIT;
    labels.push({ text: comp.ref, x: cx + vx, y: cy - 2, anchor: 'start', kind: 'ref' });
    if (val) labels.push({ text: val, x: cx + vx, y: cy + 8, anchor: 'start', kind: 'val' });
  }

  const markSvg: string[] = [];
  if (spec.marks) {
    for (const mk of spec.marks) {
      const pt = transformLocalPt({ x: mk.lx, y: mk.ly }, place);
      markSvg.push(el('text', {
        x: pt.x * UNIT,
        y: pt.y * UNIT + 2.5,
        'text-anchor': 'middle',
        class: mk.className ?? 'sym-mark',
      }, mk.text));
    }
  }

  const bodySvg = [
    el('g', { transform: svgTransform(place) }, spec.body),
    ...markSvg,
  ];

  // Expand fullBox to include pins and label estimates.
  let minX = bodyBox.minX;
  let minY = bodyBox.minY;
  let maxX = bodyBox.maxX;
  let maxY = bodyBox.maxY;
  for (const p of placedPins) {
    minX = Math.min(minX, p.gx);
    minY = Math.min(minY, p.gy);
    maxX = Math.max(maxX, p.gx);
    maxY = Math.max(maxY, p.gy);
  }
  for (const l of labels) {
    const estW = (l.text.length * 5.2) / UNIT;
    const gx = l.x / UNIT;
    const gy = l.y / UNIT;
    if (l.anchor === 'start') {
      minX = Math.min(minX, gx);
      maxX = Math.max(maxX, gx + estW);
    } else if (l.anchor === 'end') {
      minX = Math.min(minX, gx - estW);
      maxX = Math.max(maxX, gx);
    } else {
      minX = Math.min(minX, gx - estW / 2);
      maxX = Math.max(maxX, gx + estW / 2);
    }
    minY = Math.min(minY, gy - 0.8);
    maxY = Math.max(maxY, gy + 0.4);
  }

  return {
    comp,
    part,
    family: spec.family,
    place,
    pins: placedPins,
    bodyBox,
    blockedCells,
    fullBox: { minX, minY, maxX, maxY },
    bodySvg,
    labels,
  };
}
