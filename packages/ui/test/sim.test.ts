// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { Doc, type PartDef, type PartResolver } from '@cadllm/core';
import {
  buildRunCommand,
  deriveRenderState,
  parsePressIntervals,
  parseReadCodeOutput,
  parseTransitionTable,
  sampleTraceAt,
} from '../src/lib/sim.ts';

const PARTS: Record<string, PartDef> = {
  arduino_uno: {
    id: 'arduino_uno',
    name: 'Arduino Uno',
    summary: 'MCU',
    category: 'board',
    refPrefix: 'U',
    pins: [
      { id: 'D2', name: 'D2', type: 'bidir' },
      { id: 'D13', name: 'D13', type: 'bidir' },
      { id: '5V', name: '5V', type: 'power_out' },
      { id: 'GND1', name: 'GND', type: 'power_in' },
    ],
    sim: [{ kind: 'mcu', ref: 'avr8js-uno' }],
  },
  res: {
    id: 'res',
    name: 'Resistor',
    summary: 'res',
    category: 'passive',
    refPrefix: 'R',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { resistance: { type: 'number', unit: 'Ω', default: '1k' } },
    views: { sch: 'resistor', bb: 'axial' },
  },
  led: {
    id: 'led',
    name: 'LED',
    summary: 'led',
    category: 'io',
    refPrefix: 'D',
    pins: [{ id: '1', name: 'A', type: 'passive' }, { id: '2', name: 'K', type: 'passive' }],
    props: { color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red' } },
    views: { sch: 'led', bb: 'led' },
  },
  button: {
    id: 'button',
    name: 'Button',
    summary: 'btn',
    category: 'io',
    refPrefix: 'SW',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { state: { type: 'enum', options: ['released', 'pressed'], default: 'released' } },
    views: { sch: 'button', bb: 'button' },
  },
};

const resolver: PartResolver = { get: id => PARTS[id] };

describe('parseReadCodeOutput', () => {
  it('strips [code REF] header and handles empty code', () => {
    expect(parseReadCodeOutput('blink rev=3 [code U1]\nvoid setup() {}\nvoid loop() {}', 'U1'))
      .toBe('void setup() {}\nvoid loop() {}');
    expect(parseReadCodeOutput('blink rev=0 U1: no code', 'U1')).toBe('');
  });
});

describe('parseTransitionTable', () => {
  it('parses digital transition table with engine project rev prefix and footer', () => {
    const text = [
      'blink rev=2 t     D13',
      '0     1',
      '1s    0',
      '2s    1',
      '3s    0',
      '4s    1',
      'serial U1: hello',
      'warn: truncated',
      '… 5 more rows',
    ].join('\n');

    const trace = parseTransitionTable(text);
    expect(trace).not.toBeNull();
    expect(trace!.probes).toEqual(['D13']);
    expect(trace!.duration).toBe(4);
    expect(trace!.frames).toEqual([
      { t: 0, nets: { D13: '1' } },
      { t: 1, nets: { D13: '0' } },
      { t: 2, nets: { D13: '1' } },
      { t: 3, nets: { D13: '0' } },
      { t: 4, nets: { D13: '1' } },
    ]);
    expect(trace!.serial).toEqual({ U1: 'hello' });
    expect(trace!.warnings).toEqual(['truncated']);
    expect(trace!.truncatedRows).toBe(5);
  });

  it('parses mixed digital and SI analog voltage columns', () => {
    const text = [
      't     D2 D13 V(LA)',
      '0     0  0   0',
      '500ms 1  1   2.15',
      '1s    0  0   250m',
    ].join('\n');

    const trace = parseTransitionTable(text);
    expect(trace).not.toBeNull();
    expect(trace!.frames).toEqual([
      { t: 0, nets: { D2: '0', D13: '0', 'V(LA)': 0 } },
      { t: 0.5, nets: { D2: '1', D13: '1', 'V(LA)': 2.15 } },
      { t: 1, nets: { D2: '0', D13: '0', 'V(LA)': 0.25 } },
    ]);
  });

  it('returns null for non-trace output', () => {
    expect(parseTransitionTable('blink rev=1 V(LA) 2.15 I(R1) 12.9m')).toBeNull();
  });
});

describe('run command, press intervals, and RenderState derivation', () => {
  it('builds run command and parses press intervals', () => {
    expect(buildRunCommand({ duration: '4s', press: 'SW1@0.5s-1.0s', probes: 'D2,D13' }))
      .toBe('run 4s press=SW1@0.5s-1.0s probes=D2,D13');
    expect(parsePressIntervals('SW1@0.5s-1.0s, SW2@1.2s-2s')).toEqual([
      { ref: 'SW1', start: 0.5, end: 1 },
      { ref: 'SW2', start: 1.2, end: 2 },
    ]);
  });

  it('derives LED glow through series resistor and button pressed state at playback time t', () => {
    const doc = new Doc(resolver);
    doc.transact(tx => {
      tx.addComponent({ ref: 'U1', part: 'arduino_uno' });
      tx.addComponent({ ref: 'SW1', part: 'button', props: { state: 'released' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.connect('5V', ['U1.5V', 'SW1.1']);
      tx.connect('D2', ['SW1.2', 'U1.D2']);
      tx.connect('D13', ['U1.D13', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'U1.GND1']);
    });

    const trace = parseTransitionTable([
      't     D2 D13',
      '0     0  0',
      '500ms 1  1',
      '1s    0  0',
    ].join('\n'))!;

    const press = parsePressIntervals('SW1@0.5s-1.0s');
    expect(sampleTraceAt(trace, 0.75, doc.read)).toEqual({ D2: '1', D13: '1' });

    const s0 = deriveRenderState(doc.read, trace, 0.25, press, new Set());
    expect(s0?.parts?.D1).toEqual({ on: false, level: 0 });
    expect(s0?.parts?.SW1).toEqual({ on: false });

    const sOn = deriveRenderState(doc.read, trace, 0.75, press, new Set());
    expect(sOn?.parts?.D1).toEqual({ on: true, level: 1 });
    expect(sOn?.parts?.SW1).toEqual({ on: true });
    expect(sOn?.nets?.LA).toBe('1');
  });

  it('supports demo backend code read/edit and canned blink simulation trace', async () => {
    const { createDemoBackend } = await import('../src/lib/demo.ts');
    const demo = createDemoBackend();
    const codeOut = await demo.call<string>('read', { code: 'U1' });
    expect(parseReadCodeOutput(codeOut, 'U1')).toContain('digitalWrite(13, HIGH);');

    const simRes = await demo.call<string>('sim', { run: 'run 4s probes=D13' });
    const parsed = parseTransitionTable(simRes);
    expect(parsed).not.toBeNull();
    expect(parsed!.duration).toBe(4);
    expect(parsed!.frames.map(f => [f.t, f.nets.D13])).toEqual([
      [0, '1'],
      [1, '0'],
      [2, '1'],
      [3, '0'],
      [4, '1'],
    ]);
    expect(parsed!.serial.U1).toBe('blink ready');
  });
});
