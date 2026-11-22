// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { Query, type Circuit, type PartDef, type PartResolver } from '@cadllm/core';
import {
  buildConnectCnl,
  formatPlaceEdit,
  formatSchPlace,
  moveSchPlace,
  nextAutoNetName,
  nextAutoRef,
  parseBbHole,
  parseGridPlace,
  parseSchPlace,
  rotateSchPlace,
  shiftBbPlace,
  snapToGrid,
} from '../src/lib/place.ts';

const PARTS: Record<string, PartDef> = {
  res: {
    id: 'res',
    name: 'Resistor',
    summary: 'resistor',
    category: 'passive',
    refPrefix: 'R',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
  },
  led: {
    id: 'led',
    name: 'LED',
    summary: 'led',
    category: 'io',
    refPrefix: 'D',
    pins: [
      { id: '1', name: 'A', type: 'passive' },
      { id: '2', name: 'K', type: 'passive' },
    ],
  },
};

const resolver: PartResolver = { get: id => PARTS[id] };

describe('schematic place helpers', () => {
  it('parses x,y,rot,m variants', () => {
    expect(parseSchPlace('12,4')).toEqual({ x: 12, y: 4, rot: 0, mirror: false });
    expect(parseSchPlace('12,4,90')).toEqual({ x: 12, y: 4, rot: 90, mirror: false });
    expect(parseSchPlace('30, 10, 180, m')).toEqual({ x: 30, y: 10, rot: 180, mirror: true });
    expect(parseSchPlace('-5,0,m')).toEqual({ x: -5, y: 0, rot: 0, mirror: true });
    expect(parseSchPlace('12.5,4')).toBeUndefined();
    expect(parseSchPlace('12,4,45')).toBeUndefined();
    expect(parseSchPlace('12')).toBeUndefined();
    expect(parseSchPlace(undefined)).toBeUndefined();
  });

  it('formats canonically omitting default rot=0 and mirror=false', () => {
    expect(formatSchPlace({ x: 12, y: 4, rot: 0, mirror: false })).toBe('12,4');
    expect(formatSchPlace({ x: 12, y: 4, rot: 90, mirror: false })).toBe('12,4,90');
    expect(formatSchPlace({ x: 12, y: 4, rot: 0, mirror: true })).toBe('12,4,0,m');
    expect(formatSchPlace({ x: -0, y: -0, rot: 270, mirror: true })).toBe('0,0,270,m');
  });

  it('rotates clockwise in 90-degree increments and preserves coords/mirror', () => {
    expect(rotateSchPlace('12,4')).toBe('12,4,90');
    expect(rotateSchPlace('12,4,90')).toBe('12,4,180');
    expect(rotateSchPlace('12,4,270')).toBe('12,4');
    expect(rotateSchPlace('12,4,90,m')).toBe('12,4,180,m');
    expect(rotateSchPlace(undefined)).toBe('0,0,90');
  });

  it('shifts existing placement by grid delta or places at fallback', () => {
    expect(moveSchPlace('10,20,90', 3, -4, { x: 99, y: 99 })).toBe('13,16,90');
    expect(moveSchPlace(undefined, 3, -4, { x: 7, y: 8 })).toBe('7,8');
  });

  it('snaps SVG coordinates to grid steps', () => {
    expect(snapToGrid({ x: 124, y: 36 })).toEqual({ x: 12, y: 4 });
    expect(snapToGrid({ x: -3, y: -16 })).toEqual({ x: 0, y: -2 });
  });
});

describe('breadboard & naming helpers', () => {
  it('parses and shifts breadboard spans cleanly', () => {
    expect(parseBbHole('e10')).toEqual({ row: 4, col: 10 });
    expect(parseBbHole('T+3')).toBeUndefined();
    expect(shiftBbPlace('E10-E14', 'E10', 'F12')).toBe('F12-F16');
    expect(shiftBbPlace('E10-E14', 'E10', 'J28', 30)).toBe('J28');
    expect(shiftBbPlace('E10-E14', 'E10', 'J62')).toBe('J62');
    expect(shiftBbPlace('E10', 'E10', 'D5')).toBe('D5');
    expect(parseGridPlace('-4, 2')).toEqual({ x: -4, y: 2 });
  });

  it('generates next auto ref and net names case-insensitively', () => {
    expect(nextAutoRef('R', ['r1', 'R2', 'D1'])).toBe('R3');
    expect(nextAutoRef('U', [])).toBe('U1');
    expect(nextAutoNetName(['VCC', 'n1', 'N2'])).toBe('N3');
  });

  it('formats place edit and builds pin-to-pin CNL reusing pinA net or creating N<k>', () => {
    expect(formatPlaceEdit('R1', 'sch', '12,4,90')).toBe('R1 @sch:12,4,90');
    const circuit: Circuit = {
      meta: {},
      seq: 3,
      components: {
        c1: { id: 'c1', ref: 'R1', part: 'res', props: {}, place: {} },
        c2: { id: 'c2', ref: 'D1', part: 'led', props: {}, place: {} },
      },
      nets: {
        n1: { id: 'n1', name: 'LA', pins: ['c1:2'] },
      },
    };
    const q = new Query(circuit, resolver);
    expect(buildConnectCnl(q, 'R1.2', 'D1.A')).toBe('LA: R1.2 D1.A');
    expect(buildConnectCnl(q, 'D1.K', 'R1.1')).toBe('N1: D1.K R1.1');
    expect(buildConnectCnl(q, 'R1.1', 'R1.1')).toBeUndefined();
  });
});
