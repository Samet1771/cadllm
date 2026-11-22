// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Component, type PartDef, type PinDef, type PinKey, type Query } from '@cadllm/core';
import { UNIT, type Pt, type ViewIssue } from '../types.ts';
import {
  holePt,
  isHoleOnBoard,
  parseHole,
  stripOfHole,
  type BoardSpec,
  type ParsedHole,
  type StripInfo,
} from './board.ts';

export interface PinPlacement {
  pin: PinDef;
  key: PinKey;
  label: string;
  pt: Pt;
  hole?: string;
  parsedHole?: ParsedHole;
  strip?: StripInfo;
  offBoard: boolean;
  onBoard: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedComp {
  comp: Component;
  part: PartDef | undefined;
  family: string;
  pins: PinPlacement[];
  box: Box;
  offBoard: boolean;
}

export const DEFAULT_PITCH: Record<string, number> = {
  axial: 4,
  disc: 2,
  radial: 2,
  led: 2,
  button: 2,
  slide_switch: 2,
  buzzer: 2,
  to92: 1,
  pot: 1,
  probe: 1,
};

const OFFBOARD_ONLY_FAMILIES = new Set(['battery', 'supply', 'arduino_uno']);
const TWO_HOLE_RE = /^([TB][+-]\d+|[A-J]\d+)-([TB][+-]\d+|[A-J]\d+)$/i;
const XY_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)),([+-]?(?:\d+\.?\d*|\.\d+))$/;

export function familyOf(q: Query, comp: Component): string {
  return q.parts.get(comp.part)?.views?.bb ?? 'unknown';
}

export function isOffBoardOnly(family: string): boolean {
  return OFFBOARD_ONLY_FAMILIES.has(family);
}

export function defaultPitchFor(family: string): number {
  return DEFAULT_PITCH[family] ?? 1;
}

function makePins(comp: Component, part: PartDef | undefined): PinDef[] {
  if (part) return part.pins;
  return [
    { id: '1', name: '1', type: 'passive' },
    { id: '2', name: '2', type: 'passive' },
  ];
}

function offBoardLayout(
  q: Query,
  comp: Component,
  part: PartDef | undefined,
  family: string,
  ox: number,
  oy: number,
): { pins: PinPlacement[]; box: Box } {
  const defs = makePins(comp, part);
  const makePin = (pin: PinDef, pt: Pt): PinPlacement => {
    const key = pinKey(comp.id, pin.id);
    return { pin, key, label: q.pinLabel(key), pt, offBoard: true, onBoard: false };
  };

  if (family === 'battery') {
    const w = 6 * UNIT;
    const h = 4 * UNIT;
    const pins = defs.map((p, i) => makePin(p, { x: ox + w, y: oy + (i === 0 ? 1.2 : 2.8) * UNIT }));
    return { pins, box: { x: ox, y: oy, w, h } };
  }

  if (family === 'supply') {
    const w = 7 * UNIT;
    const h = 4.6 * UNIT;
    const pins = defs.map((p, i) => makePin(p, { x: ox + w, y: oy + (i === 0 ? 1.4 : 3.2) * UNIT }));
    return { pins, box: { x: ox, y: oy, w, h } };
  }

  if (family === 'arduino_uno') {
    const w = 22 * UNIT;
    const h = 16 * UNIT;
    const topIds = ['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
    const botIds = ['IOREF', 'RESET', '3V3', '5V', 'GND1', 'GND2', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
    const pins: PinPlacement[] = [];
    for (const p of defs) {
      const ti = topIds.indexOf(p.id);
      if (ti >= 0) {
        pins.push(makePin(p, { x: ox + (3 + ti) * UNIT, y: oy + 0.8 * UNIT }));
        continue;
      }
      const bi = botIds.indexOf(p.id);
      if (bi >= 0) {
        pins.push(makePin(p, { x: ox + (6 + bi) * UNIT, y: oy + h - 0.8 * UNIT }));
        continue;
      }
      pins.push(makePin(p, { x: ox + w - UNIT, y: oy + (2 + pins.length) * UNIT }));
    }
    return { pins, box: { x: ox, y: oy, w, h } };
  }

  const count = Math.max(1, defs.length);
  const w = Math.max(3, count + 1) * UNIT;
  const h = 2.4 * UNIT;
  const pins = defs.map((p, i) => makePin(p, { x: ox + (i + 1) * UNIT, y: oy + h * 0.5 }));
  return { pins, box: { x: ox, y: oy, w, h } };
}

function boxFromPins(pins: PinPlacement[], padX = UNIT, padY = UNIT): Box {
  if (pins.length === 0) return { x: 0, y: 0, w: UNIT, h: UNIT };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pins) {
    if (p.pt.x < minX) minX = p.pt.x;
    if (p.pt.y < minY) minY = p.pt.y;
    if (p.pt.x > maxX) maxX = p.pt.x;
    if (p.pt.y > maxY) maxY = p.pt.y;
  }
  return {
    x: minX - padX,
    y: minY - padY,
    w: Math.max(UNIT, maxX - minX) + padX * 2,
    h: Math.max(UNIT, maxY - minY) + padY * 2,
  };
}

function makeBoardPin(q: Query, board: BoardSpec, comp: Component, pin: PinDef, parsed: ParsedHole): PinPlacement {
  const key = pinKey(comp.id, pin.id);
  const onBoard = isHoleOnBoard(board, parsed);
  return {
    pin,
    key,
    label: q.pinLabel(key),
    pt: holePt(parsed),
    hole: parsed.name,
    parsedHole: parsed,
    strip: stripOfHole(parsed),
    offBoard: false,
    onBoard,
  };
}

export interface ResolvePlaceResult {
  placed?: PlacedComp;
  issues: ViewIssue[];
  unplaced?: boolean;
}

export function resolveCompPlace(q: Query, board: BoardSpec, comp: Component): ResolvePlaceResult {
  const part = q.parts.get(comp.part);
  const family = familyOf(q, comp);
  if (family === 'breadboard' || family === 'none') {
    return { issues: [] };
  }

  const raw = comp.place.bb?.trim();
  if (!raw) {
    return { issues: [], unplaced: true };
  }

  // Off-board placement: x,y in hole pitches relative to board top-left
  const xyMatch = raw.match(XY_RE);
  if (xyMatch) {
    const x = Number(xyMatch[1]);
    const y = Number(xyMatch[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        issues: [{ level: 'error', code: 'bad_place', message: `${comp.ref}: invalid coordinates "${raw}"`, at: [comp.ref] }],
      };
    }
    const { pins, box } = offBoardLayout(q, comp, part, family, x * UNIT, y * UNIT);
    return {
      placed: { comp, part, family, pins, box, offBoard: true },
      issues: [],
    };
  }

  if (isOffBoardOnly(family)) {
    return {
      issues: [{
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: ${family} must use off-board x,y placement (e.g. -8,3)`,
        at: [comp.ref],
      }],
    };
  }

  const defs = makePins(comp, part);
  const issues: ViewIssue[] = [];

  // Two-hole span placement: E10-E14 or E10-F10
  const twoMatch = raw.match(TWO_HOLE_RE);
  if (twoMatch) {
    const h1 = parseHole(twoMatch[1]!);
    const h2 = parseHole(twoMatch[2]!);
    if (!h1 || !h2 || defs.length !== 2) {
      return {
        issues: [{
          level: 'error',
          code: 'bad_place',
          message: `${comp.ref}: "${raw}" requires a 2-pin part and valid holes`,
          at: [comp.ref],
        }],
      };
    }
    const p1 = makeBoardPin(q, board, comp, defs[0]!, h1);
    const p2 = makeBoardPin(q, board, comp, defs[1]!, h2);
    for (const p of [p1, p2]) {
      if (!p.onBoard) {
        issues.push({
          level: 'error',
          code: 'off_board',
          message: `${p.label} at ${p.hole} is outside breadboard (1..${board.cols})`,
          at: [comp.ref, p.label, p.hole!],
        });
      }
    }
    return {
      placed: {
        comp,
        part,
        family,
        pins: [p1, p2],
        box: boxFromPins([p1, p2], 0.8 * UNIT, 0.8 * UNIT),
        offBoard: false,
      },
      issues,
    };
  }

  // Single-hole placement: E10
  const start = parseHole(raw);
  if (!start) {
    return {
      issues: [{
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: cannot parse breadboard placement "${raw}"`,
        at: [comp.ref],
      }],
    };
  }

  if (family === 'dip') {
    if (start.row !== 'E' || defs.length < 2 || defs.length % 2 !== 0) {
      return {
        issues: [{
          level: 'error',
          code: 'bad_place',
          message: `${comp.ref}: DIP must be placed on row E (e.g. E10) with an even pin count`,
          at: [comp.ref],
        }],
      };
    }
    const half = defs.length / 2;
    const pins: PinPlacement[] = [];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const holeStr = i < half ? `E${start.col + i}` : `F${start.col + (defs.length - 1 - i)}`;
      const parsed = parseHole(holeStr)!;
      const pp = makeBoardPin(q, board, comp, def, parsed);
      if (!pp.onBoard) {
        issues.push({
          level: 'error',
          code: 'off_board',
          message: `${pp.label} at ${pp.hole} is outside breadboard (1..${board.cols})`,
          at: [comp.ref, pp.label, pp.hole!],
        });
      }
      pins.push(pp);
    }
    return {
      placed: {
        comp,
        part,
        family,
        pins,
        box: boxFromPins(pins, 0.6 * UNIT, 0.6 * UNIT),
        offBoard: false,
      },
      issues,
    };
  }

  // Inline placement along start.row with default pitch
  const pitch = defaultPitchFor(family);
  const pins: PinPlacement[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]!;
    const holeStr = `${start.row}${start.col + i * pitch}`;
    const parsed = parseHole(holeStr)!;
    const pp = makeBoardPin(q, board, comp, def, parsed);
    if (!pp.onBoard) {
      issues.push({
        level: 'error',
        code: 'off_board',
        message: `${pp.label} at ${pp.hole} is outside breadboard (1..${board.cols})`,
        at: [comp.ref, pp.label, pp.hole!],
      });
    }
    pins.push(pp);
  }
  return {
    placed: {
      comp,
      part,
      family,
      pins,
      box: boxFromPins(pins, 0.8 * UNIT, 0.8 * UNIT),
      offBoard: false,
    },
    issues,
  };
}
