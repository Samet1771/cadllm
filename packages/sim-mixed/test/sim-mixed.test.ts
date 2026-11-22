// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';
import { loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import type { Logic } from '@cadllm/sim-digital';
import type { UnoPinName, UnoPinState } from '@cadllm/sim-mcu';
import { describe, expect, it } from 'vitest';
import { formatMixed, runMixed, type UnoLike } from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);

const ALL_PINS: UnoPinName[] = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
];

class FakeUno implements UnoLike {
  serial = '';
  time = 0;
  readonly pins = new Map<UnoPinName, UnoPinState>();
  readonly inputs = new Map<UnoPinName, Logic | number>();
  private stepFn: (uno: FakeUno, prevT: number, nextT: number, emit: (t: number, pin: UnoPinName, level: Logic) => void) => void;

  constructor(stepFn: FakeUno['stepFn'], init?: (uno: FakeUno) => void) {
    for (const p of ALL_PINS) this.pins.set(p, { mode: 'input', level: 'Z' });
    this.stepFn = stepFn;
    init?.(this);
  }

  pin(name: UnoPinName): UnoPinState {
    return this.pins.get(name)!;
  }

  setInput(name: UnoPinName, level: Logic | number): void {
    this.inputs.set(name, level);
  }

  digitalRead(name: UnoPinName): Logic {
    const v = this.inputs.get(name);
    if (typeof v === 'number') return v >= 2.5 ? '1' : '0';
    return v ?? 'Z';
  }

  setPin(name: UnoPinName, mode: UnoPinState['mode'], level: Logic, t: number, emit: (t: number, pin: UnoPinName, level: Logic) => void): void {
    const prev = this.pins.get(name)!;
    if (prev.mode === mode && prev.level === level) return;
    this.pins.set(name, { mode, level });
    emit(t, name, mode === 'output' ? level : 'Z');
  }

  run(seconds: number, onPinChange?: (t: number, pin: UnoPinName, level: Logic) => void): void {
    const prevT = this.time;
    const nextT = prevT + seconds;
    this.time = nextT;
    this.stepFn(this, prevT, nextT, (t, pin, level) => onPinChange?.(t, pin, level));
  }
}

describe('@cadllm/sim-mixed', () => {
  it('co-simulates Blink with quasi-static LED voltage and current', () => {
    const doc = loadCircuit(`cnl 1
[circuit]
D1 led red
R1 res 220
U1 arduino_uno

D13: R1.1 U1.D13
GND: D1.K U1.GND
LA:  D1.A R1.2
`, lib);

    const trace = runMixed(doc.read, {
      until: 4,
      probes: ['D13', 'V(LA)', 'I(D1)'],
      firmware: { U1: 'fake-blink' },
      slice: 0.05,
      createUno: () => new FakeUno((uno, prevT, nextT, emit) => {
        // Toggle at t = 0.05 (init HIGH), 1.0, 2.0, 3.0
        if (prevT === 0) uno.setPin('D13', 'output', '1', 0.01, emit);
        if (prevT < 1 && nextT >= 1) uno.setPin('D13', 'output', '0', 1, emit);
        if (prevT < 2 && nextT >= 2) uno.setPin('D13', 'output', '1', 2, emit);
        if (prevT < 3 && nextT >= 3) uno.setPin('D13', 'output', '0', 3, emit);
      }),
    });

    expect(trace.warnings).toEqual([]);
    expect(trace.changes.filter(c => c.net === 'D13')).toEqual([
      { t: 0.01, net: 'D13', v: '1' },
      { t: 1, net: 'D13', v: '0' },
      { t: 2, net: 'D13', v: '1' },
      { t: 3, net: 'D13', v: '0' },
    ]);

    const highSample = trace.analog.find(s => s.t === 0.01)!;
    expect(highSample.values['V(LA)']).toBeGreaterThan(1.8);
    expect(highSample.values['V(LA)']).toBeLessThan(2.2);
    expect(highSample.values['I(D1)']).toBeGreaterThan(0.008);
    expect(highSample.values['I(D1)']).toBeLessThan(0.015);

    const lowSample = trace.analog.find(s => s.t === 1)!;
    expect(lowSample.values['V(LA)']).toBeCloseTo(0, 6);
    expect(lowSample.values['I(D1)']).toBeCloseTo(0, 6);

    const table = formatMixed(trace, ['D13', 'V(LA)', 'I(D1)'], doc.read);
    expect(table).toContain('D13');
    expect(table).toContain('V(LA)');
    expect(table).toContain('I(D1)');
    expect(table.split('\n')).toHaveLength(6); // header + t=0 + 4 transitions
  });

  it('propagates button stimulus into MCU input and drives LED output', () => {
    const doc = loadCircuit(`cnl 1
[circuit]
D1  led         red
R1  res         220
R2  res         10k
SW1 button      released
U1  arduino_uno

5V:  SW1.1 U1.5V
D2:  R2.1 SW1.2 U1.D2
D13: R1.1 U1.D13
GND: D1.K R2.2 U1.GND
LA:  D1.A R1.2
`, lib);

    const trace = runMixed(doc.read, {
      until: 2,
      stimulus: [
        { t: 0.5, ref: 'SW1', state: 'closed' },
        { t: 1.0, ref: 'SW1', state: 'open' },
      ],
      probes: ['D2', 'D13', 'I(D1)'],
      firmware: { U1: 'fake-button' },
      slice: 0.01,
      createUno: () => new FakeUno(
        (uno, _prevT, nextT, emit) => {
          const d2 = uno.digitalRead('D2');
          uno.setPin('D13', 'output', d2 === '1' ? '1' : '0', nextT, emit);
        },
        uno => {
          uno.pins.set('D13', { mode: 'output', level: '0' });
        },
      ),
    });

    const d2Changes = trace.changes.filter(c => c.net === 'D2');
    expect(d2Changes).toEqual([
      { t: 0, net: 'D2', v: '0' },
      { t: 0.5, net: 'D2', v: '1' },
      { t: 1, net: 'D2', v: '0' },
    ]);

    const d13Changes = trace.changes.filter(c => c.net === 'D13');
    expect(d13Changes.some(c => c.t >= 0.5 && c.t <= 0.52 && c.v === '1')).toBe(true);
    expect(d13Changes.some(c => c.t >= 1.0 && c.t <= 1.02 && c.v === '0')).toBe(true);
    const onSample = trace.analog.find(s => s.t >= 0.5 && s.t < 1.0 && s.values['I(D1)']! > 0.008);
    expect(onSample).toBeDefined();
  });

  it('supports input_pullup and analog divider voltage feedback', () => {
    const doc = loadCircuit(`cnl 1
[circuit]
SW1 button      released
R1  res         10k
R2  res         10k
U1  arduino_uno

5V:  R1.1 U1.5V
A0:  R1.2 R2.1 U1.A0
D2:  SW1.1 U1.D2
GND: SW1.2 R2.2 U1.GND
`, lib);

    let seenA0: number | undefined;
    const trace = runMixed(doc.read, {
      until: 0.5,
      stimulus: [{ t: 0.2, ref: 'SW1', state: 'closed' }],
      probes: ['D2', 'V(A0)'],
      firmware: { U1: 'fake-pullup' },
      slice: 0.05,
      createUno: () => new FakeUno(
        (uno, _prevT, nextT, emit) => {
          const a0 = uno.inputs.get('A0');
          if (typeof a0 === 'number') seenA0 = a0;
          const d2 = uno.digitalRead('D2');
          uno.setPin('D13', 'output', d2 === '0' ? '1' : '0', nextT, emit);
        },
        uno => {
          uno.pins.set('D2', { mode: 'input_pullup', level: 'Z' });
          uno.pins.set('D13', { mode: 'output', level: '0' });
        },
      ),
    });

    expect(seenA0).toBeCloseTo(2.5, 2);
    expect(trace.changes.filter(c => c.net === 'D2')).toEqual([
      { t: 0, net: 'D2', v: '1' },
      { t: 0.2, net: 'D2', v: '0' },
    ]);
    expect(trace.analog[0]!.values['V(A0)']).toBeCloseTo(2.5, 2);
  });

  it('bridges MCU pins with external 74hc04 logic gates and propagation delay', () => {
    const doc = loadCircuit(`cnl 1
[circuit]
U1 arduino_uno
U2 74hc04

5V:  U1.5V U2.VCC
GND: U1.GND U2.GND
A:   U1.D3 U2.1A
Y:   U2.1Y U1.D4
`, lib);

    let readD4: Logic | undefined;
    const trace = runMixed(doc.read, {
      until: 1e-3,
      probes: ['A', 'Y'],
      firmware: { U1: 'fake-gate' },
      slice: 1e-4,
      createUno: () => new FakeUno(
        (uno, prevT, _nextT, emit) => {
          if (prevT === 0) uno.setPin('D3', 'output', '1', 5e-5, emit);
          if (prevT >= 1e-4) readD4 = uno.digitalRead('D4');
        },
        uno => {
          uno.pins.set('D3', { mode: 'output', level: '0' });
        },
      ),
    });

    expect(trace.changes.filter(c => c.net === 'Y')).toEqual([
      { t: 1e-8, net: 'Y', v: '1' },
      { t: 5.001e-5, net: 'Y', v: '0' },
    ]);
    expect(readD4).toBe('0');
  });

  it('caps formatMixed at 40 rows, is deterministic, and rejects missing firmware', () => {
    const doc = loadCircuit(`cnl 1
[circuit]
U1 arduino_uno
GND: U1.GND
D13: U1.D13
`, lib);

    const makeOpts = () => ({
      until: 0.05,
      probes: ['D13'],
      firmware: { U1: 'fake-fast' },
      slice: 0.001,
      createUno: () => new FakeUno(
        (uno, _prevT, nextT, emit) => {
          const cur = uno.pin('D13').level;
          uno.setPin('D13', 'output', cur === '1' ? '0' : '1', nextT, emit);
        },
        uno => {
          uno.pins.set('D13', { mode: 'output', level: '0' });
        },
      ),
    });

    const t1 = runMixed(doc.read, makeOpts());
    const t2 = runMixed(doc.read, makeOpts());
    expect(t1).toEqual(t2);

    const formatted = formatMixed(t1, ['D13'], doc.read);
    const lines = formatted.split('\n');
    expect(lines).toHaveLength(42); // header + 40 rows + "… N more"
    expect(lines[lines.length - 1]).toMatch(/^… \d+ more$/);

    expect(() => runMixed(doc.read, { until: 1, probes: ['D13'], firmware: {} })).toThrow(CadError);
  });
});
