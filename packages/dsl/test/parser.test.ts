// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { CadErrors } from '@cadllm/core';
import { parseCnl } from '../src/index.ts';

describe('parseCnl', () => {
  it('parses header, meta, circuit, placements, and tests AST', () => {
    const src = `cnl 1
meta name="blinker #1; test" units=mm

[circuit]
# comment line
R1 res 330 note="10k 1%" ; R2 res 10k # inline comment
U1 74hc00 @bb:E10
U1 @sch:40,20
VCC: R1.1 U1.VCC ; GND: R1.2 U1.GND

[breadboard]
R1 @F20-F24
U1 @E10

[schematic]
U1 @40,20

[pcb]
U1 @12.7,8.0,90 top

[tests]
test "nand truth table"
  logic in=SW1 out=U1.1Y
  expect table
    0 1 -> 1
    1 1 -> 0

test "transient and dc"
  tran 10m probes=V(LA),I(D1)
  expect I(D1) 8m..15m
  expect V(LA) >= 1.8
  expect V(OUT) < 5V
  expect V(MID) = 2.5
`;
    const doc = parseCnl(src);
    expect(doc.version).toBe(1);
    expect(doc.meta).toEqual({ name: 'blinker #1; test', units: 'mm' });
    expect(doc.circuit).toHaveLength(6);
    expect(doc.circuit[0]).toMatchObject({
      kind: 'component',
      line: 6,
      ref: 'R1',
      part: 'res',
      value: '330',
      props: { note: '10k 1%' },
    });
    expect(doc.circuit[2]).toMatchObject({
      kind: 'component',
      ref: 'U1',
      part: '74hc00',
      place: { bb: 'E10' },
    });
    expect(doc.circuit[3]).toMatchObject({
      kind: 'place',
      ref: 'U1',
      place: { sch: '40,20' },
    });
    expect(doc.breadboard).toEqual([
      { line: 12, ref: 'R1', pos: 'F20-F24' },
      { line: 13, ref: 'U1', pos: 'E10' },
    ]);
    expect(doc.schematic).toEqual([{ line: 16, ref: 'U1', pos: '40,20' }]);
    expect(doc.pcb).toEqual([{ line: 19, ref: 'U1', pos: '12.7,8.0,90 top' }]);

    expect(doc.tests).toHaveLength(2);
    expect(doc.tests[0]).toEqual({
      name: 'nand truth table',
      line: 22,
      analysis: { kind: 'logic', args: { in: 'SW1', out: 'U1.1Y' }, positional: [], line: 23 },
      expects: [
        {
          kind: 'table',
          line: 24,
          rows: [
            { inputs: ['0', '1'], outputs: ['1'], line: 25 },
            { inputs: ['1', '1'], outputs: ['0'], line: 26 },
          ],
        },
      ],
    });
    expect(doc.tests[1]).toEqual({
      name: 'transient and dc',
      line: 28,
      analysis: { kind: 'tran', args: { probes: 'V(LA),I(D1)' }, positional: ['10m'], line: 29 },
      expects: [
        { kind: 'range', probe: 'I(D1)', min: 0.008, max: 0.015, minRaw: '8m', maxRaw: '15m', line: 30 },
        { kind: 'compare', probe: 'V(LA)', op: '>=', value: 1.8, raw: '1.8', line: 31 },
        { kind: 'compare', probe: 'V(OUT)', op: '<', value: 5, raw: '5V', line: 32 },
        { kind: 'compare', probe: 'V(MID)', op: '=', value: 2.5, raw: '2.5', line: 33 },
      ],
    });
  });

  it('collects syntax errors with line numbers across the whole file', () => {
    const bad = `cnl 2
[unknown]
[circuit]
R1 res "unclosed
-R1
VCC:
[tests]
test "bad"
  expect V(A) > notanumber
  expect I(D1) 10m..5m
  expect table
`;
    let caught: unknown;
    try {
      parseCnl(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CadErrors);
    const msgs = (caught as CadErrors).errors.map(String);
    expect(msgs.some(m => m.startsWith('line 1:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 2:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 4:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 5:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 6:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 9:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 10:'))).toBe(true);
    expect(msgs.some(m => m.startsWith('line 11:'))).toBe(true);
  });
});
