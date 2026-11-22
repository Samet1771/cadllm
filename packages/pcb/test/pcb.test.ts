// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import {
  autoPlacePcb,
  componentFootprintName,
  drc,
  footprint,
  formatPcbPlace,
  isPcbPart,
  pads,
  parsePcbPlace,
  pcb,
  ratsnest,
  route,
} from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);

describe('@cadllm/pcb WP0 contracts', () => {
  it('parses and formats PCB placement strings', () => {
    expect(parsePcbPlace('12.7,8')).toEqual({ x: 12.7, y: 8, rot: 0, side: 'top' });
    expect(parsePcbPlace('12.7,8,90 top')).toEqual({ x: 12.7, y: 8, rot: 90, side: 'top' });
    expect(parsePcbPlace('12.7,8,90,bottom')).toEqual({ x: 12.7, y: 8, rot: 90, side: 'bottom' });
    expect(parsePcbPlace('12.7,8 bottom')).toEqual({ x: 12.7, y: 8, rot: 0, side: 'bottom' });
    expect(parsePcbPlace('bad')).toBeUndefined();

    expect(formatPcbPlace({ x: 12.7, y: 8, rot: 0, side: 'top' })).toBe('12.7,8');
    expect(formatPcbPlace({ x: 12.7, y: 8, rot: 90, side: 'top' })).toBe('12.7,8,90');
    expect(formatPcbPlace({ x: 12.7, y: 8, rot: 0, side: 'bottom' })).toBe('12.7,8 bottom');
    expect(formatPcbPlace({ x: 12.7, y: 8, rot: 180, side: 'bottom' })).toBe('12.7,8,180 bottom');
  });

  it('identifies PCB parts and footprint names (props.footprint overrides first footprint)', () => {
    expect(isPcbPart(lib.get('res')!)).toBe(true);
    expect(isPcbPart(lib.get('arduino_uno')!)).toBe(true);
    expect(isPcbPart(lib.get('breadboard_half')!)).toBe(false);
    expect(isPcbPart(lib.get('vcc_symbol')!)).toBe(false);
    expect(isPcbPart(lib.get('gnd_symbol')!)).toBe(false);
    expect(isPcbPart(lib.get('logic_probe')!)).toBe(false);

    const doc = loadCircuit(readFileSync(resolve(import.meta.dirname, '../../../examples/led-pcb.cnl'), 'utf8'), lib);
    expect(componentFootprintName(lib.get('res')!, doc.read.requireComponent('R1'))).toBe('THT-axial');
    expect(componentFootprintName(lib.get('res')!, { id: 'c0', ref: 'R2', part: 'res', props: {}, place: {} })).toBe('0805');
  });

  it('runs WP2 ratsnest, drc, and route on examples/led-pcb.cnl', () => {
    const doc = loadCircuit(readFileSync(resolve(import.meta.dirname, '../../../examples/led-pcb.cnl'), 'utf8'), lib);
    expect(ratsnest(doc.read).count).toBeGreaterThan(0);
    expect(Array.isArray(drc(doc.read))).toBe(true);
    expect(route(doc.read).tracks.length).toBeGreaterThan(0);
  });

  // TODO(M3 WP2): verify ratsnest, routing, and 0 DRC errors on examples/led-pcb.cnl and nand-led
  it.todo('WP2: autoroutes examples/led-pcb.cnl with 0 DRC errors');
});
