// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Doc, emptyDelta, type TxInfo } from '@cadllm/core';
import { applyEdit, loadCircuit, parseCnl, printCircuit, printDelta, saveCnl } from '../src/index.ts';
import { lib } from './fixtures.ts';

describe('printCircuit', () => {
  it('supports detail 0, 1, 2, place, quoting, and select', () => {
    const doc = new Doc(lib);
    doc.transact(tx => applyEdit(tx, `
      BAT1 battery 5V
      R1 res 330 note="pull up; #1" @bb:F20-F24
      R2 res 10k
      RV1 pot 10k position=0.5
      RV2 pot 50k position=0.25
      VCC: BAT1.+ R1.1 R2.1
      MID: R1.2 RV1.W
    `));

    expect(printCircuit(doc.read, { detail: 0 })).toBe(
      '5 comps 2 nets · parts: pot×2 res×2 battery',
    );

    expect(printCircuit(doc.read, { detail: 1 })).toBe([
      'BAT1 battery 5V',
      'R1   res     330 note="pull up; #1"',
      'R2   res     10k',
      'RV1  pot     10k',
      'RV2  pot     50k position=0.25',
      '',
      'MID: R1.2 RV1.W',
      'VCC: BAT1.+ R1.1 R2.1',
    ].join('\n'));

    expect(printCircuit(doc.read, { detail: 2, place: true })).toBe([
      'BAT1 battery 5V',
      'R1   res     330 note="pull up; #1" @bb:F20-F24',
      'R2   res     10k',
      'RV1  pot     10k position=0.5',
      'RV2  pot     50k position=0.25',
      '',
      'MID: R1.2 RV1.W',
      'VCC: BAT1.+ R1.1 R2.1',
    ].join('\n'));

    expect(printCircuit(doc.read, { select: ['R1', 'net:VCC'] })).toBe([
      'R1 res 330 note="pull up; #1"',
      '',
      'VCC: BAT1.+ R1.1 R2.1',
    ].join('\n'));

    expect(printCircuit(doc.read, { select: ['R1', 'net:VCC'], place: true })).toBe([
      'R1 res 330 note="pull up; #1" @bb:F20-F24',
      '',
      'VCC: BAT1.+ R1.1 R2.1',
    ].join('\n'));

    expect(printCircuit(doc.read, { select: ['R1'], detail: 0 })).toBe(
      '1 comp 0 nets · parts: res',
    );
    expect(printCircuit(doc.read, { select: [] })).toBe('');

    // Multi-word pcb placement is quoted when printed inline with place:true
    doc.transact(tx => applyEdit(tx, 'R1 @pcb:12.7,8.0,90 top'));
    expect(printCircuit(doc.read, { select: ['R1'], place: true })).toBe(
      'R1 res 330 note="pull up; #1" @bb:F20-F24 @pcb:"12.7,8.0,90 top"',
    );
  });
});

describe('printDelta', () => {
  const doc = new Doc(lib);

  it('prints empty delta', () => {
    const info: TxInfo = { rev: 5, source: 'ai', delta: emptyDelta(), notes: [] };
    expect(printDelta(info, doc.read)).toBe('ok rev=5 (no change)');
  });

  it('prints every delta shape and notes on one compact line', () => {
    const info: TxInfo = {
      rev: 13,
      source: 'ai',
      delta: {
        added: ['R3'],
        removed: ['R2'],
        changed: ['R1'],
        renamed: [['R4', 'R10']],
        netsAdded: ['LA'],
        netsRemoved: ['OLD'],
        netsChanged: ['VCC'],
        netsRenamed: [['N3', 'LA']],
      },
      notes: ['merged N3 into LA'],
    };
    expect(printDelta(info, doc.read)).toBe(
      'ok rev=13 +R3 -R2 ~R1 R4>R10 nets: +LA -OLD ~VCC N3>LA · merged N3 into LA',
    );
  });

  it('formats real Doc transaction deltas including auto-net merges', () => {
    const d = new Doc(lib);
    const i1 = d.transact(tx => {
      tx.addComponent({ ref: 'R1', part: 'res' });
      tx.addComponent({ ref: 'R2', part: 'res' });
      tx.connect(undefined, ['R1.2', 'R2.1']);
    });
    expect(printDelta(i1, d.read)).toBe('ok rev=1 +R1 +R2 nets: +N1');

    const i2 = d.transact(tx => {
      tx.addComponent({ ref: 'R3', part: 'res' });
      tx.connect('LA', ['R3.1', 'R2.1']);
    });
    expect(printDelta(i2, d.read)).toBe('ok rev=2 +R3 nets: +LA -N1 · merged N1 into LA');
  });
});

describe('saveCnl and loadCircuit round-trip', () => {
  it('round-trips examples/nand-led.cnl verbatim', () => {
    const path = resolve(import.meta.dirname, '../../../examples/nand-led.cnl');
    const golden = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const doc = loadCircuit(golden, lib);
    expect(doc.rev).toBe(0);
    expect(saveCnl(doc)).toBe(golden);
    expect(parseCnl(saveCnl(doc)).tests).toHaveLength(2);
  });

  it('round-trips [code U1], moves code on mv, and drops code on remove', () => {
    const src = `cnl 1
meta name=sketch

[circuit]
U1 74hc00

[code U1]
void setup() {
  pinMode(13, OUTPUT);
}

void loop() {}

[tests]
test "run"
  run 2s probes=D13
  expect D13@1s = 1
`;
    const doc = loadCircuit(src, lib);
    expect(doc.read.circuit.meta['__code:U1']).toContain('pinMode(13, OUTPUT);');
    expect(saveCnl(doc)).toBe(src);

    doc.transact(tx => applyEdit(tx, 'mv U1 U2'));
    expect(doc.read.circuit.meta['__code:U1']).toBeUndefined();
    expect(doc.read.circuit.meta['__code:U2']).toContain('pinMode(13, OUTPUT);');
    expect(saveCnl(doc)).toContain('[code U2]');

    doc.transact(tx => applyEdit(tx, '-U2'));
    expect(doc.read.circuit.meta['__code:U2']).toBeUndefined();
    expect(saveCnl(doc)).not.toContain('[code');
  });

  it('round-trips placements across breadboard, schematic, and pcb, plus props and cap', () => {
    const d1 = new Doc(lib);
    d1.transact(tx => applyEdit(tx, `
      meta name="rc-filter" units=mm
      C1 cap 100n @bb:E12
      R1 res 1k @bb:F20-F24 @sch:10,20 @pcb:12.7,8.0,90 top
      RV1 pot 20k position=0.75
      IN: R1.1 RV1.1
      OUT: R1.2 C1.1 RV1.W
    `));
    const saved1 = saveCnl(d1);
    const d2 = loadCircuit(saved1, lib);
    const saved2 = saveCnl(d2);
    expect(saved2).toBe(saved1);
    expect(d2.read.requireComponent('R1').place).toEqual({
      bb: 'F20-F24',
      sch: '10,20',
      pcb: '12.7,8.0,90 top',
    });
    expect(d2.read.requireComponent('RV1').props).toEqual({
      resistance: '20k',
      position: '0.75',
    });
  });
});
