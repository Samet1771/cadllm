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
    expect(doc.pcbStmts).toEqual([]);

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

  it('parses [code U1] verbatim, M2 analyses (ac, run) and expect measures', () => {
    const src = `cnl 1
meta name=mcu-test

[circuit]
U1 74hc00

[code U1]
// C++ brackets & # comments stay verbatim
int pins[] = {13, 2};
#define LED 13

void setup() {
  pinMode(LED, OUTPUT);
}

[tests]
test "ac and measures"
  ac dec 10 10 100k probes=V(OUT)
  expect max(V(OUT)) < 5.1
  expect V(LA)@1.5s > 1.8
  expect freq(V(OUT)) 900..1.1k
  expect duty(D13) 45%..55%

test "mcu run"
  run 2s press=SW1@0.5s-1.0s probes=D2,D13
  expect period(D13) 1.9s..2.1s
  expect D13@0.75s = 1
`;
    const doc = parseCnl(src);
    expect(doc.code.U1).toBe([
      '// C++ brackets & # comments stay verbatim',
      'int pins[] = {13, 2};',
      '#define LED 13',
      '',
      'void setup() {',
      '  pinMode(LED, OUTPUT);',
      '}',
    ].join('\n'));
    expect(doc.tests).toHaveLength(2);
    expect(doc.tests[0]!.analysis).toEqual({
      kind: 'ac',
      args: { probes: 'V(OUT)' },
      positional: ['dec', '10', '10', '100k'],
      line: 18,
    });
    expect(doc.tests[0]!.expects).toEqual([
      { kind: 'compare', probe: 'V(OUT)', measure: 'max', op: '<', value: 5.1, raw: '5.1', line: 19 },
      { kind: 'compare', probe: 'V(LA)', measure: 'at', at: 1.5, op: '>', value: 1.8, raw: '1.8', line: 20 },
      { kind: 'range', probe: 'V(OUT)', measure: 'freq', min: 900, max: 1100, minRaw: '900', maxRaw: '1.1k', line: 21 },
      { kind: 'range', probe: 'D13', measure: 'duty', min: 0.45, max: 0.55, minRaw: '45%', maxRaw: '55%', line: 22 },
    ]);
    expect(doc.tests[1]!.analysis).toEqual({
      kind: 'run',
      args: { press: 'SW1@0.5s-1.0s', probes: 'D2,D13' },
      positional: ['2s'],
      line: 25,
    });
    expect(doc.tests[1]!.expects).toEqual([
      { kind: 'range', probe: 'D13', measure: 'period', min: 1.9, max: 2.1, minRaw: '1.9s', maxRaw: '2.1s', line: 26 },
      { kind: 'compare', probe: 'D13', measure: 'at', at: 0.75, op: '=', value: 1, raw: '1', line: 27 },
    ]);
  });

  it('rejects unknown measures and removed toggles syntax', () => {
    const bad = `cnl 1
[circuit]
[tests]
test "bad measures"
  run 1s
  expect bogus(V(OUT)) < 1
  expect V(OUT)@nope > 1
  expect D13 toggles 2s±100m
`;
    expect(() => parseCnl(bad)).toThrow(CadErrors);
    try {
      parseCnl(bad);
    } catch (e) {
      const msgs = (e as CadErrors).errors.map(String);
      expect(msgs).toHaveLength(3);
      expect(msgs[0]).toMatch(/^line 6: unknown measure "bogus"/);
      expect(msgs[1]).toMatch(/^line 7: invalid time "nope"/);
      expect(msgs[2]).toMatch(/^line 8: cannot parse expect/);
    }
  });

  it('parses [pcb] board, rules, track, and via statements and rejects bad syntax', () => {
    const src = `cnl 1
[circuit]
R1 res 330
VCC: R1.1

[pcb]
R1 @10,10,90 top
board 50x40
rules clearance=0.2 track=0.25 via=0.6 drill=0.3
track VCC F 0.4 10,10 20,10 20,15
via VCC 20,15 size=0.8 drill=0.4
`;
    const doc = parseCnl(src);
    expect(doc.pcb).toEqual([{ line: 7, ref: 'R1', pos: '10,10,90 top' }]);
    expect(doc.pcbStmts).toEqual([
      { kind: 'board', line: 8, outline: [[0, 0], [50, 0], [50, 40], [0, 40]] },
      { kind: 'rules', line: 9, rules: { clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 } },
      { kind: 'track', line: 10, net: 'VCC', layer: 'F', width: 0.4, points: [[10, 10], [20, 10], [20, 15]] },
      { kind: 'via', line: 11, net: 'VCC', at: [20, 15], size: 0.8, drill: 0.4 },
    ]);

    const bad = `cnl 1
[pcb]
board 0x40
rules bogus=1
track VCC Z 0.4 0,0 1,1
via VCC 1,2 nope=3
-tracks VCC
`;
    let caught: unknown;
    try { parseCnl(bad); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CadErrors);
    expect((caught as CadErrors).errors).toHaveLength(5);
  });
});
