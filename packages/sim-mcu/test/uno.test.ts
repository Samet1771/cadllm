// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadError } from '@cadllm/core';
import type { Logic } from '@cadllm/sim-digital';
import { describe, expect, it } from 'vitest';
import { parseIntelHex, Uno, type UnoPinName } from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixtureHex(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.hex`), 'utf8');
}

describe('parseIntelHex', () => {
  it('parses blink.hex and computes binary size', () => {
    const hex = loadFixtureHex('blink');
    const parsed = parseIntelHex(hex);
    expect(parsed.size).toBe(924);
    expect(parsed.flash.length).toBe(16384);
    expect(parsed.flash[0]).not.toBe(0);
  });

  it('rejects malformed Intel HEX records', () => {
    expect(() => parseIntelHex('not-hex')).toThrow(CadError);
    expect(() => parseIntelHex(':02000000000000\n:00000001FF')).toThrow(CadError);
    expect(() => parseIntelHex(':0000000000')).toThrow(CadError); // missing EOF
  });
});

describe('Uno simulator', () => {
  it('runs blink.hex for 4s within performance budget and toggles D13 every 1.000s ± 1ms', () => {
    const uno = new Uno(loadFixtureHex('blink'));
    const changes: Array<{ t: number; pin: UnoPinName; level: Logic }> = [];

    const t0 = performance.now();
    uno.run(4.05, (t, pin, level) => changes.push({ t, pin, level }));
    const wallMs = performance.now() - t0;

    expect(wallMs).toBeLessThan(10_000);
    expect(uno.time).toBeCloseTo(4.05, 5);

    const d13Toggles = changes.filter((c) => c.pin === 'D13' && (c.level === '0' || c.level === '1'));
    // Expected: initial '0' on pinMode(13, OUTPUT), then HIGH (~0s), LOW (~1s), HIGH (~2s), LOW (~3s), HIGH (~4s)
    const levels = d13Toggles.map((c) => c.level);
    expect(levels).toEqual(['0', '1', '0', '1', '0', '1']);

    // Check intervals between the 1s transitions (indices 1..5)
    for (let i = 2; i < d13Toggles.length; i++) {
      const dt = d13Toggles[i]!.t - d13Toggles[i - 1]!.t;
      expect(dt).toBeGreaterThanOrEqual(0.999);
      expect(dt).toBeLessThanOrEqual(1.001);
    }

    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '1' });
  });

  it('echoes button input on D2 to D13 within a few microseconds', () => {
    const uno = new Uno(loadFixtureHex('button_echo'));
    uno.run(0.005);
    expect(uno.pin('D2')).toEqual({ mode: 'input', level: 'Z' });
    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '0' });

    const riseEvents: Array<{ t: number; level: Logic }> = [];
    const tPress = uno.time;
    uno.setInput('D2', '1');
    uno.run(0.001, (t, pin, level) => {
      if (pin === 'D13') riseEvents.push({ t, level });
    });
    expect(riseEvents).toHaveLength(1);
    expect(riseEvents[0]!.level).toBe('1');
    expect(riseEvents[0]!.t - tPress).toBeLessThan(50e-6);
    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '1' });

    const fallEvents: Array<{ t: number; level: Logic }> = [];
    const tRelease = uno.time;
    uno.setInput('D2', '0');
    uno.run(0.001, (t, pin, level) => {
      if (pin === 'D13') fallEvents.push({ t, level });
    });
    expect(fallEvents).toHaveLength(1);
    expect(fallEvents[0]!.level).toBe('0');
    expect(fallEvents[0]!.t - tRelease).toBeLessThan(50e-6);

    // Numeric voltage threshold >= 2.5V -> '1', < 2.5V -> '0'
    uno.setInput('D2', 3.3);
    uno.run(0.001);
    expect(uno.pin('D13').level).toBe('1');

    uno.setInput('D2', 1.2);
    uno.run(0.001);
    expect(uno.pin('D13').level).toBe('0');
  });

  it('captures USART0 serial output', () => {
    const uno = new Uno(loadFixtureHex('serial_hi'));
    uno.run(0.05);
    expect(uno.serial).toBe('hi\r\n');
  });

  it('reads analog voltages via ADC on A0..A5', () => {
    const uno = new Uno(loadFixtureHex('analog_read'));
    uno.setInput('A0', 2.5);
    uno.run(0.03);
    const firstLines = uno.serial.trim().split(/\r?\n/).map(Number);
    expect(firstLines.length).toBeGreaterThanOrEqual(1);
    expect(firstLines[0]).toBeGreaterThanOrEqual(510);
    expect(firstLines[0]).toBeLessThanOrEqual(514);

    uno.setInput('A0', 1.0);
    uno.run(0.06);
    const allLines = uno.serial.trim().split(/\r?\n/).map(Number);
    const latest = allLines[allLines.length - 1]!;
    expect(latest).toBeGreaterThanOrEqual(203);
    expect(latest).toBeLessThanOrEqual(206);
  });

  it('reports input_pullup mode and pulls floating input HIGH', () => {
    const uno = new Uno(loadFixtureHex('pullup'));
    uno.run(0.005);
    expect(uno.pin('D2')).toEqual({ mode: 'input_pullup', level: '1' });
    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '1' });

    uno.setInput('D2', '0');
    uno.run(0.001);
    expect(uno.pin('D2')).toEqual({ mode: 'input_pullup', level: '0' });
    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '0' });

    uno.setInput('D2', 'Z');
    uno.run(0.001);
    expect(uno.pin('D2')).toEqual({ mode: 'input_pullup', level: '1' });
    expect(uno.pin('D13')).toEqual({ mode: 'output', level: '1' });
  });

  it('is strictly deterministic across runs', () => {
    const hex = loadFixtureHex('blink');
    const traceA: Array<[number, UnoPinName, Logic]> = [];
    const traceB: Array<[number, UnoPinName, Logic]> = [];

    const a = new Uno(hex);
    a.run(2.2, (t, p, l) => traceA.push([t, p, l]));

    const b = new Uno(hex);
    b.run(2.2, (t, p, l) => traceB.push([t, p, l]));

    expect(traceA).toEqual(traceB);
    expect(a.time).toBe(b.time);
  });

  it('throws CadError on invalid pin names or inputs', () => {
    const uno = new Uno(loadFixtureHex('blink'));
    expect(() => uno.pin('D99' as UnoPinName)).toThrow(CadError);
    expect(() => uno.setInput('D99' as UnoPinName, '1')).toThrow(CadError);
    expect(() => uno.setInput('A0', Number.NaN)).toThrow(CadError);
    expect(() => uno.run(-1)).toThrow(CadError);
  });
});
