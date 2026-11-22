// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Component, type PartDef, type PinDef, type Query } from '@cadllm/core';
import { el, path } from '../../svg.ts';
import { UNIT } from '../../types.ts';
import { dirDelta, transformBox, transformDir, transformLocalPt } from '../place.ts';
import type { Dir, LabelSpec, PlacedPin, PlacedSymbol, SchPlace } from '../types.ts';
import { valueLabel } from './common.ts';

const GND_PIN_RE = /^(GND|AGND|DGND|PGND|VSS|VEE|V-|GND\d+)$/i;

function classifyPins(pins: PinDef[]): { left: PinDef[]; right: PinDef[]; top: PinDef[]; bottom: PinDef[] } {
  const left: PinDef[] = [];
  const right: PinDef[] = [];
  const top: PinDef[] = [];
  const bottom: PinDef[] = [];
  const other: PinDef[] = [];

  for (const p of pins) {
    if (p.type === 'power_in' || p.type === 'power_out') {
      if (GND_PIN_RE.test(p.name)) bottom.push(p);
      else top.push(p);
    } else if (p.type === 'output' || p.type === 'tristate' || p.type === 'open_collector') {
      right.push(p);
    } else if (p.type === 'input') {
      left.push(p);
    } else if (p.type === 'bidir') {
      if (/^D\d+$/i.test(p.name)) right.push(p);
      else if (/^A\d+$/i.test(p.name)) left.push(p);
      else other.push(p);
    } else {
      other.push(p);
    }
  }

  if (other.length > 0) {
    if (left.length === 0 && right.length === 0) {
      const mid = Math.ceil(other.length / 2);
      left.push(...other.slice(0, mid));
      right.push(...other.slice(mid));
    } else {
      for (const p of other) {
        if (left.length <= right.length) left.push(p);
        else right.push(p);
      }
    }
  }

  return { left, right, top, bottom };
}

function distributeVertical(count: number, maxSide: number, pitch: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [0];
  if (count === maxSide) {
    const start = -Math.floor(((count - 1) * pitch) / 2);
    return Array.from({ length: count }, (_, i) => start + i * pitch);
  }
  if (maxSide === count * 2 && pitch === 2) {
    const fullStart = -Math.floor(((maxSide - 1) * pitch) / 2);
    return Array.from({ length: count }, (_, i) => fullStart + 1 + i * 4);
  }
  const span = Math.max(count - 1, (maxSide - 1) * pitch);
  const start = -Math.floor(span / 2);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let y = Math.round(start + (i * span) / (count - 1));
    const prev = out[i - 1];
    if (prev !== undefined && y <= prev) y = prev + 1;
    out.push(y);
  }
  return out;
}

function distributeHorizontal(count: number, pitch: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [0];
  const start = -Math.floor(((count - 1) * pitch) / 2);
  return Array.from({ length: count }, (_, i) => start + i * pitch);
}

export function buildIc(q: Query, comp: Component, part: PartDef, place: SchPlace, family = 'ic'): PlacedSymbol {
  const { left, right, top, bottom } = classifyPins(part.pins);
  const maxSide = Math.max(left.length, right.length, 1);
  const pitch = maxSide <= 8 ? 2 : 1;
  const sideSpan = (maxSide - 1) * pitch;
  const padY = top.length > 0 || bottom.length > 0 ? 2 : 1;
  const halfH = Math.max(2, Math.ceil(sideSpan / 2) + padY);

  const maxLeftLen = Math.max(0, ...left.map(p => p.name.length));
  const maxRightLen = Math.max(0, ...right.map(p => p.name.length));
  const maxTB = Math.max(top.length, bottom.length, 0);
  const tbPitch = 3;
  const sideWidth = Math.ceil((maxLeftLen + maxRightLen) * 0.55) + 3;
  const tbWidth = maxTB > 1 ? (maxTB - 1) * tbPitch + 4 : 6;
  const halfW = Math.max(4, Math.ceil(Math.max(sideWidth, tbWidth) / 2));

  const localBox = { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH };
  const bodyBox = transformBox(localBox, place);

  const localPins: { pin: PinDef; lx: number; ly: number; dir: Dir }[] = [];
  const leftYs = distributeVertical(left.length, maxSide, pitch);
  left.forEach((pin, i) => localPins.push({ pin, lx: -halfW - 1, ly: leftYs[i]!, dir: 'L' }));

  const rightYs = distributeVertical(right.length, maxSide, pitch);
  right.forEach((pin, i) => localPins.push({ pin, lx: halfW + 1, ly: rightYs[i]!, dir: 'R' }));

  const topXs = distributeHorizontal(top.length, tbPitch);
  top.forEach((pin, i) => localPins.push({ pin, lx: topXs[i]!, ly: -halfH - 1, dir: 'U' }));

  const botXs = distributeHorizontal(bottom.length, tbPitch);
  bottom.forEach((pin, i) => localPins.push({ pin, lx: botXs[i]!, ly: halfH + 1, dir: 'D' }));

  const placedPins: PlacedPin[] = localPins.map(lp => {
    const pt = transformLocalPt({ x: lp.lx, y: lp.ly }, place);
    const key = pinKey(comp.id, lp.pin.id);
    return {
      pin: lp.pin,
      key,
      label: q.pinLabel(key),
      gx: pt.x,
      gy: pt.y,
      dir: transformDir(lp.dir, place),
    };
  });

  const blockedCells: { gx: number; gy: number }[] = [];
  for (let gx = bodyBox.minX; gx <= bodyBox.maxX; gx++) {
    for (let gy = bodyBox.minY; gy <= bodyBox.maxY; gy++) {
      blockedCells.push({ gx, gy });
    }
  }

  const inset = 2;
  const rx = bodyBox.minX * UNIT + inset;
  const ry = bodyBox.minY * UNIT + inset;
  const rw = (bodyBox.maxX - bodyBox.minX) * UNIT - inset * 2;
  const rh = (bodyBox.maxY - bodyBox.minY) * UNIT - inset * 2;

  const bodySvg: string[] = [
    el('rect', { x: rx, y: ry, width: rw, height: rh, rx: 2, class: 'ic-box' }),
  ];

  for (const pp of placedPins) {
    const px = pp.gx * UNIT;
    const py = pp.gy * UNIT;
    const d = dirDelta(pp.dir);
    // Stub goes inward by 1 grid step plus the 2px inset to meet the box border flush.
    const bx = px - d.x * (UNIT + inset);
    const by = py - d.y * (UNIT + inset);
    bodySvg.push(el('path', { d: path(['M', px, py, 'L', bx, by]), class: 'sym' }));

    // Pin name inside the box border.
    if (pp.dir === 'L') {
      bodySvg.push(el('text', { x: bx + 4, y: by + 2.5, 'text-anchor': 'start', class: 'pin-lbl' }, pp.pin.name));
    } else if (pp.dir === 'R') {
      bodySvg.push(el('text', { x: bx - 4, y: by + 2.5, 'text-anchor': 'end', class: 'pin-lbl' }, pp.pin.name));
    } else if (pp.dir === 'U') {
      bodySvg.push(el('text', { x: bx, y: by + 10, 'text-anchor': 'middle', class: 'pin-lbl' }, pp.pin.name));
    } else {
      bodySvg.push(el('text', { x: bx, y: by - 4, 'text-anchor': 'middle', class: 'pin-lbl' }, pp.pin.name));
    }
  }

  const val = valueLabel(comp, part) ?? part.id;
  // Place ref + value above the box's top-left corner, clear of any top-edge pin stubs.
  const topPins = placedPins.filter(p => p.dir === 'U');
  const minTopPinX = topPins.length > 0 ? Math.min(...topPins.map(p => p.gx * UNIT)) : Infinity;
  const estMaxW = Math.max(comp.ref.length, val.length) * 5.2;
  const fitsBeforeTopPin = rx + estMaxW + 4 <= minTopPinX;
  const lblX = fitsBeforeTopPin ? rx : rx - 2;
  const lblAnchor: LabelSpec['anchor'] = fitsBeforeTopPin ? 'start' : 'end';
  const labels: LabelSpec[] = [
    { text: comp.ref, x: lblX, y: ry - 14, anchor: lblAnchor, kind: 'ref' },
    { text: val, x: lblX, y: ry - 4, anchor: lblAnchor, kind: 'val' },
  ];

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
  minY = Math.min(minY, bodyBox.minY - 2);
  if (!fitsBeforeTopPin) minX = Math.min(minX, bodyBox.minX - Math.ceil(estMaxW / UNIT));
  maxY = Math.max(maxY, bodyBox.maxY + 1);

  return {
    comp,
    part,
    family,
    place,
    pins: placedPins,
    bodyBox,
    blockedCells,
    fullBox: { minX, minY, maxX, maxY },
    bodySvg,
    labels,
  };
}
