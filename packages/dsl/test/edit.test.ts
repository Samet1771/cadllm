// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { CadErrors, Doc } from '@cadllm/core';
import { applyEdit, loadCircuit, printDelta, saveCnl } from '../src/index.ts';
import { lib } from './fixtures.ts';

describe('applyEdit', () => {
  it('supports component upsert, ~patch, prop deletion, placements, nets, -remove, -disconnect, mv, meta', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, `
      meta author="ada"
      BAT1 battery 5V
      R1 res 330 note="drop; #1" ; D1 led red
      VCC: BAT1.+ R1.1 ; LA: R1.2 D1.A ; GND: D1.K BAT1.-
    `));

    expect(doc.read.circuit.meta.author).toBe('ada');
    expect(doc.read.requireComponent('R1').props).toEqual({ resistance: '330', note: 'drop; #1' });

    // Upsert existing ref, ~patch with value= and key=, placement-only, mv
    doc.transact(tx => applyEdit(tx, `
      R1 res 470
      ~R1 note=
      ~D1 value=green @bb:E10
      R1 @pcb:12.7,8.0,90 top
      mv R1 R10
    `));

    const r10 = doc.read.requireComponent('R10');
    expect(r10.props).toEqual({ resistance: '470' });
    expect(r10.place).toEqual({ pcb: '12.7,8.0,90 top' });
    const d1 = doc.read.requireComponent('D1');
    expect(d1.props.color).toBe('green');
    expect(d1.place).toEqual({ bb: 'E10' });

    // Disconnect pin, delete net, remove component, delete placement & meta
    doc.transact(tx => applyEdit(tx, `
      -LA: D1.A
      -GND
      -D1
      ~R10 @pcb:
      meta author=
    `));
    expect(doc.read.component('D1')).toBeUndefined();
    expect(doc.read.net('GND')).toBeUndefined();
    expect(doc.read.requireComponent('R10').place).toEqual({});
    expect(doc.read.circuit.meta.author).toBeUndefined();
    expect(doc.read.sortedPins(doc.read.requireNet('LA'))).toEqual(['R10.2']);
  });

  it('supports upsert changing part and value= alias', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, `
      R1 res 330
      R2 res 10k
    `));
    doc.transact(tx => applyEdit(tx, `
      R2 led green
      ~R1 value=470
    `));
    const r2 = doc.read.requireComponent('R2');
    expect(r2.part).toBe('led');
    expect(r2.props).toEqual({ color: 'green' });
    expect(doc.read.requireComponent('R1').props.resistance).toBe('470');
  });

  it('resets defaulted props on k= and deletes non-defaulted props, preserving round-trip', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, `
      R1 res 330 note="temp"
      ~R1 resistance=
      ~R1 note=
    `));
    expect(doc.read.requireComponent('R1').props).toEqual({ resistance: '1k' });
    const saved = saveCnl(doc);
    expect(saveCnl(loadCircuit(saved, lib))).toBe(saved);

    doc.transact(tx => applyEdit(tx, '~R1 value=470'));
    expect(doc.read.requireComponent('R1').props.resistance).toBe('470');
    doc.transact(tx => applyEdit(tx, '~R1 value='));
    expect(doc.read.requireComponent('R1').props.resistance).toBe('1k');
  });

  it('reports meta-only edits via printDelta and rejects reserved __ keys', () => {
    const doc = new Doc(lib);
    const i1 = doc.transact(tx => applyEdit(tx, 'meta name="x y"'));
    expect(printDelta(i1, doc.read)).toBe('ok rev=1 · meta name="x y"');

    const i2 = doc.transact(tx => applyEdit(tx, 'meta name=z'));
    expect(printDelta(i2, doc.read)).toBe('ok rev=2 · meta name=z');

    const i3 = doc.transact(tx => applyEdit(tx, 'meta name='));
    expect(printDelta(i3, doc.read)).toBe('ok rev=3 · meta -name');

    // No-op meta edit does not bump rev or emit spurious notes
    const i4 = doc.transact(tx => applyEdit(tx, 'meta author=ada'));
    expect(i4.rev).toBe(4);
    const i5 = doc.transact(tx => applyEdit(tx, 'meta author=ada'));
    expect(printDelta(i5, doc.read)).toBe('ok rev=4 (no change)');

    expect(() => doc.transact(tx => applyEdit(tx, 'meta __tests=hack'))).toThrow(/reserved meta key "__tests"/);
    expect(doc.rev).toBe(4);
  });

  it('collects 5+ distinct error kinds with line numbers and keeps the transaction atomic', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, `
      BAT1 battery 5V
      U1 74hc00
      R1 res 330
      VCC: BAT1.+ U1.VCC R1.1
      GND: BAT1.- U1.GND
    `));
    const beforeRev = doc.rev;
    const beforeJson = JSON.stringify(doc.toJSON());

    let caught: unknown;
    try {
      doc.transact(tx => applyEdit(tx, [
        'R2 res 1k',
        'R3 unknown_part 100',
        'VCC: U1.VDD',
        'VCC: badpin',
        '~R1 bogus=123',
        'GND: R1.1',
        'R4',
      ].join('\n')));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(CadErrors);
    const lines = (caught as CadErrors).errors.map(String);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('line 2: unknown part unknown_part · search with find');
    expect(lines[1]).toMatch(/^line 3: U1 has no pin VDD · pins: 1:1A 2:1B/);
    expect(lines[2]).toMatch(/^line 4: bad pin reference "badpin"/);
    expect(lines[3]).toMatch(/^line 5: R1: res has no prop bogus/);
    expect(lines[4]).toMatch(/^line 6: .*would join VCC and GND/);
    expect(lines[5]).toMatch(/^line 7: incomplete statement "R4"/);

    // Atomic: rev and circuit untouched
    expect(doc.rev).toBe(beforeRev);
    expect(JSON.stringify(doc.toJSON())).toBe(beforeJson);
    expect(doc.read.component('R2')).toBeUndefined();
  });
});
