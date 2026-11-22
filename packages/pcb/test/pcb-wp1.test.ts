// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { Doc } from '@cadllm/core';
import { applyEdit, loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import {
  autoPlacePcb,
  footprint,
  footprintNames,
  isPcbPart,
  pads,
  pcb,
  renderPcb,
} from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);
const repo = resolve(import.meta.dirname, '../../..');

const padAt = (fpName: string, id: string) => {
  const p = footprint(fpName).pads.find(x => x.id === id);
  if (!p) throw new Error(`${fpName}: missing pad ${id}`);
  return p;
};

describe('M3 WP1: footprints', () => {
  it('generates every footprint name used by PCB parts in parts/', () => {
    const seen = new Set<string>();
    for (const part of lib.all()) {
      if (!isPcbPart(part)) continue;
      for (const fpName of part.footprints ?? []) {
        seen.add(fpName);
        const fp = footprint(fpName);
        expect(fp.name).toBe(fpName);
        expect(fp.courtyard[0]).toBeGreaterThan(0);
        expect(fp.courtyard[1]).toBeGreaterThan(0);
        // Every part pin id must map to a pad
        const padIds = new Set(fp.pads.map(p => p.id));
        for (const pin of part.pins) {
          expect(padIds.has(pin.id), `${part.id} / ${fpName} missing pad ${pin.id}`).toBe(true);
        }
        // Through-hole pads must have valid drill smaller than copper
        for (const p of fp.pads) {
          expect(p.size[0]).toBeGreaterThan(0);
          expect(p.size[1]).toBeGreaterThan(0);
          if (p.layers === 'TH') {
            expect(p.drill).toBeGreaterThan(0);
            expect(p.drill!).toBeLessThan(Math.min(p.size[0], p.size[1]));
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...footprintNames()].sort());
    expect(() => footprint('NoSuchFootprint')).toThrow(/unknown PCB footprint/);
  });

  it('matches datasheet pin pitches for DIP, SOIC, TO-92, axial, 0805, LED, caps, switch, pot, headers', () => {
    // DIP-14: 2.54 mm vertical pitch, 7.62 mm row spacing
    const dip14 = footprint('DIP-14');
    expect(dip14.pads).toHaveLength(14);
    expect(Math.abs(padAt('DIP-14', '2').at[1] - padAt('DIP-14', '1').at[1])).toBeCloseTo(2.54, 4);
    expect(Math.abs(padAt('DIP-14', '14').at[0] - padAt('DIP-14', '1').at[0])).toBeCloseTo(7.62, 4);
    expect(padAt('DIP-14', '14').at[1]).toBeCloseTo(padAt('DIP-14', '1').at[1], 4);
    expect(padAt('DIP-14', '8').at[1]).toBeCloseTo(padAt('DIP-14', '7').at[1], 4);

    // SOIC-8 / SOIC-14: 1.27 mm pitch, 5.40 mm row spacing, F layer
    const soic14 = footprint('SOIC-14');
    expect(Math.abs(padAt('SOIC-14', '2').at[1] - padAt('SOIC-14', '1').at[1])).toBeCloseTo(1.27, 4);
    expect(Math.abs(padAt('SOIC-14', '14').at[0] - padAt('SOIC-14', '1').at[0])).toBeCloseTo(5.4, 4);
    expect(padAt('SOIC-14', '1').layers).toBe('F');

    // TO-92: 1.27 mm pitch inline with >= 0.2 mm copper clearance
    const p1 = padAt('TO-92', '1');
    const p2 = padAt('TO-92', '2');
    const p3 = padAt('TO-92', '3');
    expect(p2.at[0] - p1.at[0]).toBeCloseTo(1.27, 4);
    expect(p3.at[0] - p2.at[0]).toBeCloseTo(1.27, 4);
    expect(1.27 - p1.size[0]).toBeGreaterThanOrEqual(0.2);

    // THT-axial: 10.16 mm default pitch
    expect(padAt('THT-axial', '2').at[0] - padAt('THT-axial', '1').at[0]).toBeCloseTo(10.16, 4);

    // 0805: IPC-7351 nominal SMD pads
    const r0805_1 = padAt('0805', '1');
    const r0805_2 = padAt('0805', '2');
    expect(r0805_1.layers).toBe('F');
    expect(r0805_2.at[0] - r0805_1.at[0]).toBeCloseTo(1.9, 4);
    expect(r0805_1.size).toEqual([1.0, 1.3]);

    // LEDs: 2.54 mm pitch
    expect(padAt('LED_D5.0mm', '2').at[0] - padAt('LED_D5.0mm', '1').at[0]).toBeCloseTo(2.54, 4);
    expect(padAt('LED_D3.0mm', '2').at[0] - padAt('LED_D3.0mm', '1').at[0]).toBeCloseTo(2.54, 4);

    // Radial electrolytic caps parameterized by name
    expect(padAt('CP_Radial_D5.0mm_P2.00mm', '2').at[0] - padAt('CP_Radial_D5.0mm_P2.00mm', '1').at[0]).toBeCloseTo(2.0, 4);
    expect(padAt('CP_Radial_D8.0mm_P3.50mm', '2').at[0] - padAt('CP_Radial_D8.0mm_P3.50mm', '1').at[0]).toBeCloseTo(3.5, 4);

    // 6 mm tactile switch & 9 mm pot & headers
    expect(padAt('SW_PUSH_6mm', '2').at[0] - padAt('SW_PUSH_6mm', '1').at[0]).toBeCloseTo(6.5, 4);
    expect(padAt('Potentiometer_THT_9mm', '2').at[0] - padAt('Potentiometer_THT_9mm', '1').at[0]).toBeCloseTo(2.5, 4);
    expect(padAt('Header_1x02_P2.54mm', '2').at[1] - padAt('Header_1x02_P2.54mm', '1').at[1]).toBeCloseTo(2.54, 4);
    expect(padAt('Header_1x03_P2.54mm', '3').at[1] - padAt('Header_1x03_P2.54mm', '1').at[1]).toBeCloseTo(5.08, 4);
  });

  it('places Arduino_Uno_R3 headers at real Uno R3 coordinates (4.064 mm D7-D8 gap, 48.26 mm row span)', () => {
    const uno = footprint('Arduino_Uno_R3');
    expect(uno.pads).toHaveLength(29);
    const d0 = padAt('Arduino_Uno_R3', 'D0');
    const d7 = padAt('Arduino_Uno_R3', 'D7');
    const d8 = padAt('Arduino_Uno_R3', 'D8');
    const a5 = padAt('Arduino_Uno_R3', 'A5');
    const a0 = padAt('Arduino_Uno_R3', 'A0');
    const vin = padAt('Arduino_Uno_R3', 'VIN');

    expect(a5.at[1] - d0.at[1]).toBeCloseTo(48.26, 3);
    expect(d0.at[0]).toBeCloseTo(a5.at[0], 3);
    expect(d7.at[0]).toBeCloseTo(vin.at[0], 3);
    expect(d0.at[0] - d7.at[0]).toBeCloseTo(7 * 2.54, 3);
    expect(d7.at[0] - d8.at[0]).toBeCloseTo(4.064, 3); // famous 0.16" Arduino gap
    expect(a0.at[0] - vin.at[0]).toBeCloseTo(5.08, 3); // 0.20" gap
  });
});

describe('M3 WP1: pads() transforms, autoPlacePcb, check, and renderPcb', () => {
  it('transforms pads with clockwise rotation and bottom-side mirroring', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, 'R1 res 1k footprint=0805\nR1 @pcb:10,20,90\nR2 res 1k footprint=0805\nR2 @pcb:10,20,90 bottom'));
    const all = pads(doc.read);
    const r1p1 = all.find(p => p.ref === 'R1' && p.pinId === '1')!;
    const r1p2 = all.find(p => p.ref === 'R1' && p.pinId === '2')!;
    // R1 top rot=90 CW: local (-0.95, 0) -> (10, 20 - 0.95); (+0.95, 0) -> (10, 20 + 0.95)
    expect(r1p1.at[0]).toBeCloseTo(10, 4);
    expect(r1p1.at[1]).toBeCloseTo(19.05, 4);
    expect(r1p2.at[1]).toBeCloseTo(20.95, 4);
    expect(r1p1.layers).toBe('F');

    // R2 bottom rot=90 CW: mirror X (-0.95 -> +0.95) then rot 90 CW -> (10, 20 + 0.95)
    const r2p1 = all.find(p => p.ref === 'R2' && p.pinId === '1')!;
    const r2p2 = all.find(p => p.ref === 'R2' && p.pinId === '2')!;
    expect(r2p1.at[0]).toBeCloseTo(10, 4);
    expect(r2p1.at[1]).toBeCloseTo(20.95, 4);
    expect(r2p2.at[1]).toBeCloseTo(19.05, 4);
    expect(r2p1.layers).toBe('B');
  });

  it('autoPlacePcb places examples/led-pcb.cnl and examples/nand-led.cnl cleanly and deterministically', () => {
    const ledDoc = loadCircuit(readFileSync(resolve(repo, 'examples/led-pcb.cnl'), 'utf8'), lib);
    const p1 = autoPlacePcb(ledDoc.read, { all: true });
    const p2 = autoPlacePcb(ledDoc.read, { all: true });
    expect(p1).toEqual(p2);
    expect(Object.keys(p1.place).sort()).toEqual(['BAT1', 'D1', 'J1', 'R1']);

    ledDoc.transact(tx => {
      for (const [ref, pl] of Object.entries(p1.place)) tx.updateComponent(ref, { place: { pcb: pl } });
    });
    expect(pcb.check(ledDoc.read).filter(i => i.level === 'error')).toEqual([]);

    const nandDoc = loadCircuit(readFileSync(resolve(repo, 'examples/nand-led.cnl'), 'utf8'), lib);
    const np = autoPlacePcb(nandDoc.read);
    expect(Object.keys(np.place).sort()).toEqual(['BAT1', 'D1', 'R1', 'R2', 'SW1', 'U1']);
    nandDoc.transact(tx => {
      for (const [ref, pl] of Object.entries(np.place)) tx.updateComponent(ref, { place: { pcb: pl } });
    });
    expect(pcb.check(nandDoc.read).filter(i => i.level === 'error')).toEqual([]);
  });

  it('check reports unplaced, bad_place, off_board, and overlap issues', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, [
      'R1 res 1k footprint=THT-axial',
      'R2 res 1k footprint=THT-axial',
      'R3 res 1k footprint=0805',
      'R4 res 1k footprint=0805',
      'R1 @pcb:10,10',
      'R2 @pcb:12,10',      // overlaps R1
      'R3 @pcb:29.5,10',    // extends off 30x20 board
      'R4 @pcb:bad_coords', // bad_place
      'R5 res 1k',          // unplaced
      'board 30x20',
    ].join('\n')));
    const issues = pcb.check(doc.read);
    const codes = new Set(issues.map(i => i.code));
    expect(codes.has('overlap')).toBe(true);
    expect(codes.has('off_board')).toBe(true);
    expect(codes.has('bad_place')).toBe(true);
    expect(codes.has('unplaced')).toBe(true);
  });

  it('renderPcb produces deterministic SVG with layers, highlights, and rasterizes cleanly via @resvg/resvg-js', () => {
    const doc = loadCircuit(readFileSync(resolve(repo, 'examples/led-pcb.cnl'), 'utf8'), lib);
    const placed = autoPlacePcb(doc.read, { all: true });
    doc.transact(tx => {
      for (const [ref, pl] of Object.entries(placed.place)) tx.updateComponent(ref, { place: { pcb: pl } });
      tx.addTrack({ net: 'VCC', layer: 'F', width: 0.4, points: [[5, 6], [12, 6]] });
      tx.addVia({ net: 'VCC', at: [12, 6] });
      tx.addTrack({ net: 'VCC', layer: 'B', width: 0.4, points: [[12, 6], [12, 12]] });
    });

    const svg = renderPcb(doc.read, {
      highlight: ['R1', 'net:VCC'],
      layers: ['F', 'B', 'silk', 'outline', 'ratsnest', 'courtyard'],
    });
    expect(svg).toBe(renderPcb(doc.read, {
      highlight: ['R1', 'net:VCC'],
      layers: ['F', 'B', 'silk', 'outline', 'ratsnest', 'courtyard'],
    }));
    expect(svg).toMatch(/^<svg [^>]*data-view="pcb"/);
    expect(svg).toContain('data-ref="R1"');
    expect(svg).toContain('data-pin="R1.1"');
    expect(svg).toContain('data-net="VCC"');
    expect(svg).toContain('class="pcb-comp hl"');
    expect(svg).toContain('class="pcb-net hl"');
    expect(svg).toContain('class="pcb-courtyard"');

    const darkSvg = renderPcb(doc.read, { theme: 'dark', labels: false, select: ['R1'] });
    expect(darkSvg).toContain('data-view="pcb"');
    expect(darkSvg).not.toContain('>R1</text>');

    const png = new Resvg(svg).render().asPng();
    expect(png.byteLength).toBeGreaterThan(1000);
    // PNG magic header
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
