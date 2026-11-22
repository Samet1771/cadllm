// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Query, type PartDef, type PartResolver } from '@cadllm/core';
import { applyEdit, loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { UNIT } from '../src/types.ts';
import { bbHoleAt, bbHolePos, breadboard } from '../src/bb/index.ts';
import { analyzeBreadboard } from '../src/bb/connect.ts';
import { resolveBoard } from '../src/bb/board.ts';
import { resolveCompPlace } from '../src/bb/place.ts';

const library = loadLibrary([builtinPartsDir]);

function loadCnl(cnl: string, extraParts: PartDef[] = []) {
  const resolver: PartResolver = {
    get: id => extraParts.find(p => p.id === id) ?? library.get(id),
  };
  const text = cnl.trimStart().startsWith('cnl ') ? cnl : `cnl 1\n[circuit]\n${cnl}`;
  return loadCircuit(text, resolver);
}

describe('breadboard holes & geometry', () => {
  it('round-trips bbHoleAt(bbHolePos(h)) === h for every hole on half and full breadboards', () => {
    for (const partId of ['breadboard_half', 'breadboard_full'] as const) {
      const doc = loadCnl(`BB1 ${partId}`);
      const part = library.get(partId)!;
      expect(part.pins.length).toBeGreaterThan(400);

      for (const pin of part.pins) {
        const pos = bbHolePos(doc.read, pin.id);
        expect(pos, `position for ${partId}.${pin.id}`).toBeDefined();
        expect(bbHoleAt(doc.read, pos!)).toBe(pin.id);
      }

      // Half-pitch channel center between E and F (0.3 in gap) must not snap to a hole
      const e1 = bbHolePos(doc.read, 'E1')!;
      const f1 = bbHolePos(doc.read, 'F1')!;
      expect(f1.y - e1.y).toBe(3 * UNIT);
      expect(bbHoleAt(doc.read, { x: e1.x, y: (e1.y + f1.y) / 2 })).toBeUndefined();
      expect(bbHoleAt(doc.read, { x: -50, y: -50 })).toBeUndefined();
    }
  });

  it('assumes an implicit half breadboard when none is in the circuit', () => {
    const doc = loadCnl('R1 res 330 @bb:E10');
    const board = resolveBoard(doc.read);
    expect(board.kind).toBe('half');
    expect(board.cols).toBe(30);
    expect(bbHolePos(doc.read, 'A30')).toBeDefined();
    expect(bbHolePos(doc.read, 'A31')).toBeUndefined();
  });
});

describe('breadboard pin mapping', () => {
  it('maps DIP-14 on E10 across channel (pins 1..7 on E10..E16, 8..14 on F16..F10)', () => {
    const doc = loadCnl('U1 74hc00 @bb:E10');
    const board = resolveBoard(doc.read);
    const res = resolveCompPlace(doc.read, board, doc.read.requireComponent('U1'));
    expect(res.issues).toEqual([]);
    const holes = res.placed!.pins.map(p => [p.pin.id, p.hole]);
    expect(holes).toEqual([
      ['1', 'E10'], ['2', 'E11'], ['3', 'E12'], ['4', 'E13'], ['5', 'E14'], ['6', 'E15'], ['7', 'E16'],
      ['8', 'F16'], ['9', 'F15'], ['10', 'F14'], ['11', 'F13'], ['12', 'F12'], ['13', 'F11'], ['14', 'F10'],
    ]);
  });

  it('maps inline parts with default pitches and explicit endpoints', () => {
    const doc = loadCnl([
      'R1 res 330 @bb:E10',
      'R2 res 1k @bb:A1-F1',
      'Q1 npn @bb:C5',
      'D1 led red @bb:H10',
    ].join('\n'));
    const board = resolveBoard(doc.read);
    const mapOf = (ref: string) =>
      resolveCompPlace(doc.read, board, doc.read.requireComponent(ref)).placed!.pins.map(p => p.hole);

    expect(mapOf('R1')).toEqual(['E10', 'E14']);
    expect(mapOf('R2')).toEqual(['A1', 'F1']);
    expect(mapOf('Q1')).toEqual(['C5', 'C6', 'C7']);
    expect(mapOf('D1')).toEqual(['H10', 'H12']);
  });
});

describe('strip grouping, rail assignment, and connectivity checks', () => {
  it('groups pins by strip and avoids jumpers when pins share a strip', () => {
    const doc = loadCnl([
      'BAT1 battery 5V @bb:-8,2',
      'R1   res 330 @bb:D10-D14',
      'D1   led red @bb:E14-E16',
      'VCC: BAT1.+ R1.1',
      'LA:  R1.2 D1.A',
      'GND: BAT1.- D1.K',
    ].join('\n'));

    const analysis = analyzeBreadboard(doc.read);
    expect(analysis.issues).toEqual([]);
    // LA shares strip col 14 (D14 and E14), so it needs 0 jumpers!
    expect(analysis.jumpers.filter(j => j.netName === 'LA')).toHaveLength(0);
    // VCC uses T+ rail (BAT1.+ -> T+ and R1.1 -> T+)
    expect(analysis.railNets.get('T+')?.name).toBe('VCC');
    // GND uses T- rail (BAT1.- -> T- and D1.K -> T-)
    expect(analysis.railNets.get('T-')?.name).toBe('GND');
    expect(analysis.jumpers.filter(j => j.netName === 'VCC')).toHaveLength(2);
    expect(analysis.jumpers.filter(j => j.netName === 'GND')).toHaveLength(2);
  });

  it('connects lower-half strips to B+/B-, bridges rails at left edge when both halves used, and detects bridged bb_short', () => {
    const doc = loadCnl([
      'BAT1 battery 5V @bb:-8,2',
      'R1   res 330 @bb:C6-C10',
      'R2   res 1k  @bb:H6-H10',
      'VCC: BAT1.+ R1.1 R2.1',
      'GND: BAT1.- R1.2 R2.2',
    ].join('\n'));
    const analysis = analyzeBreadboard(doc.read);
    expect(analysis.issues).toEqual([]);
    expect(analysis.railNets.get('T+')?.name).toBe('VCC');
    expect(analysis.railNets.get('B+')?.name).toBe('VCC');
    expect(analysis.railNets.get('T-')?.name).toBe('GND');
    expect(analysis.railNets.get('B-')?.name).toBe('GND');

    const vccJumpers = analysis.jumpers.filter(j => j.netName === 'VCC');
    // BAT1.+ -> T+1, R1.1 (C6) -> T+, R2.1 (H6) -> B+, plus one left-edge bridge T+c <-> B+c
    expect(vccJumpers.some(j => j.isBridge && j.fromHole?.startsWith('T+') && j.toHole?.startsWith('B+'))).toBe(true);
    expect(vccJumpers.some(j => j.fromHole === 'A6' && j.toHole?.startsWith('T+'))).toBe(true);
    expect(vccJumpers.some(j => j.fromHole === 'J6' && j.toHole?.startsWith('B+'))).toBe(true);

    // Bridged rails treat T+ and B+ as the same node for bb_short
    const shortDoc = loadCnl([
      'BAT1 battery 5V @bb:-8,2',
      'R1   res 330 @bb:T+5-C5',
      'R2   res 1k  @bb:B+5-H5',
      'R3   res 1k  @bb:H10-H14',
      'VCC: BAT1.+ R1.1 R3.1',
      'SIG: R2.1',
      'GND: BAT1.- R1.2 R2.2 R3.2',
    ].join('\n'));
    const shortIssues = breadboard.check(shortDoc.read);
    expect(shortIssues.some(i => i.code === 'bb_short' && i.level === 'error')).toBe(true);
  });

  it('detects bb_short when different nets share a strip or rail', () => {
    const doc = loadCnl([
      'R1 res 330 @bb:E10-E14',
      'R2 res 1k  @bb:D10-D18',
      'A: R1.1',
      'B: R2.1',
    ].join('\n'));
    const issues = breadboard.check(doc.read);
    expect(issues.some(i => i.code === 'bb_short' && i.level === 'error')).toBe(true);
  });

  it('detects overlap, off_board, bad_place, unplaced, and strip_full', () => {
    const doc = loadCnl([
      'R1 res 330 @bb:E10',
      'R2 res 1k  @bb:E10',
      'R3 res 1k  @bb:E29',
      'R4 res 1k  @bb:Z99',
      'R5 res 1k',
      'A: R1.1 R3.1',
    ].join('\n'));
    const issues = breadboard.check(doc.read);
    const codes = issues.map(i => i.code);
    expect(codes).toContain('overlap');
    expect(codes).toContain('off_board');
    expect(codes).toContain('bad_place');
    expect(codes).toContain('unplaced');

    // Fill all 5 holes in strip col 5 (A5..E5) so jumper needs a hole and triggers strip_full
    const fullDoc = loadCnl([
      'R1 res 1k @bb:A5-A10',
      'R2 res 1k @bb:B5-B10',
      'R3 res 1k @bb:C5-C10',
      'R4 res 1k @bb:D5-D10',
      'R5 res 1k @bb:E5-E10',
      'R6 res 1k @bb:E20',
      'SIG: R1.1 R2.1 R3.1 R4.1 R5.1 R6.1',
      'RET: R1.2 R2.2 R3.2 R4.2 R5.2 R6.2',
    ].join('\n'));
    const fullIssues = breadboard.check(fullDoc.read);
    expect(fullIssues.some(i => i.code === 'strip_full' && i.level === 'warn')).toBe(true);
  });

  it('ignores bb:none components (vcc/gnd symbols) and breadboard components in unplaced checks', () => {
    const doc = loadCnl([
      'BB1 breadboard_half',
      'VCC1 vcc_symbol 5',
      'GND1 gnd_symbol',
      'R1 res 330 @bb:E10',
      'VCC: VCC1.VCC R1.1',
      'GND: GND1.GND R1.2',
    ].join('\n'));
    expect(breadboard.check(doc.read)).toEqual([]);
  });
});

describe('autoPlace', () => {
  it('places examples/nand-led.cnl with 0 errors and minimal jumpers', () => {
    const cnlPath = resolve(import.meta.dirname, '../../../examples/nand-led.cnl');
    const cnl = readFileSync(cnlPath, 'utf8');
    const doc = loadCnl(cnl);

    const res = breadboard.autoPlace(doc.read);
    expect(Object.keys(res.place).sort()).toEqual(['BAT1', 'D1', 'R1', 'R2', 'SW1', 'U1']);

    const lines = Object.entries(res.place).map(([ref, pos]) => `${ref} @bb:${pos}`);
    doc.transact(tx => applyEdit(tx, lines.join('\n')));

    const issues = breadboard.check(doc.read);
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    expect(issues.filter(i => i.code === 'unplaced')).toEqual([]);

    const svg = breadboard.render(doc.read);
    expect(svg).toContain('<svg ');
    expect(svg).toContain('data-view="bb"');
    expect(svg).toContain('data-ref="U1"');
    expect(svg).toContain('data-pin="D1.A"');
    expect(svg).toContain('data-hole="E10"');
    expect(svg).toContain('data-net="VCC"');
    // Byte-identical determinism check
    expect(breadboard.render(doc.read)).toBe(svg);
  });

  it('keeps already placed parts fixed unless all=true', () => {
    const doc = loadCnl([
      'BAT1 battery 5V @bb:-8,2',
      'R1 res 330 @bb:C20',
      'D1 led red',
      'VCC: BAT1.+ R1.1',
      'LA: R1.2 D1.A',
      'GND: BAT1.- D1.K',
    ].join('\n'));

    const res = breadboard.autoPlace(doc.read);
    expect(res.place.BAT1).toBeUndefined();
    expect(res.place.R1).toBeUndefined();
    expect(res.place.D1).toBeDefined();

    const lines = Object.entries(res.place).map(([ref, pos]) => `${ref} @bb:${pos}`);
    doc.transact(tx => applyEdit(tx, lines.join('\n')));
    expect(breadboard.check(doc.read).filter(i => i.level === 'error')).toEqual([]);
  });
});

describe('render SVG, golden snapshot, themes, highlight, select, fallback', () => {
  const LED_CNL = [
    'BB1  breadboard_half',
    'BAT1 battery 5V @bb:-8,2',
    'R1   res 330    @bb:D10-D14',
    'D1   led red    @bb:E14-E16',
    'VCC: BAT1.+ R1.1',
    'LA:  R1.2 D1.A',
    'GND: BAT1.- D1.K',
  ].join('\n');

  it('matches golden SVG for an LED circuit on a half breadboard and is deterministic', async () => {
    const doc = loadCnl(LED_CNL);
    const svg1 = breadboard.render(doc.read);
    const svg2 = breadboard.render(new Query(doc.toJSON(), library));
    expect(svg1).toBe(svg2);
    await expect(svg1).toMatchFileSnapshot('./fixtures/bb-led.golden.svg');
  });

  it('supports highlight, select cropping, labels=false, dark theme, and unknown family fallback', () => {
    const customPart: PartDef = {
      id: 'mystery_mod',
      name: 'Mystery',
      summary: 'unknown bb family',
      category: 'ic',
      refPrefix: 'M',
      pins: [{ id: '1', name: 'P1', type: 'passive' }, { id: '2', name: 'P2', type: 'passive' }],
      views: { sch: 'mystery', bb: 'mystery_bb' },
    };
    const doc = loadCnl(`${LED_CNL}\nM1 mystery_mod @bb:H20`, [customPart]);

    const hlSvg = breadboard.render(doc.read, { highlight: ['R1', 'net:VCC'], theme: 'dark', labels: false });
    expect(hlSvg).toContain('data-ref="R1" class="bb-part hl"');
    expect(hlSvg).toContain('data-net="VCC" class="bb-net hl"');
    expect(hlSvg).toContain('data-ref="M1"');
    expect(hlSvg).toContain('data-pin="M1.P1"');
    expect(hlSvg).toContain('#181a1f'); // dark theme background

    const cropped = breadboard.render(doc.read, { select: ['D1'] });
    const full = breadboard.render(doc.read);
    const vbMatch = cropped.match(/viewBox="([^"]+)"/);
    const fullVbMatch = full.match(/viewBox="([^"]+)"/);
    expect(vbMatch).not.toBeNull();
    expect(fullVbMatch).not.toBeNull();
    const cw = Number(vbMatch![1]!.split(' ')[2]);
    const fw = Number(fullVbMatch![1]!.split(' ')[2]);
    expect(cw).toBeLessThan(fw);
  });
});
