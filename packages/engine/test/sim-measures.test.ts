// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import type { Logic } from '@cadllm/sim-digital';
import type { UnoPinName, UnoPinState } from '@cadllm/sim-mcu';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cadllm/sim-spice', () => ({
  op: vi.fn(async () => ({
    vectors: { 'V(OUT)': new Float64Array([2.5]), 'I(V1)': new Float64Array([-0.002]) },
    scale: { name: 'time' as const, values: new Float64Array([0]) },
    log: [],
  })),
  tran: vi.fn(async (_q: unknown, opts: { stop: number }) => {
    const n = 401;
    const t = new Float64Array(n);
    const v = new Float64Array(n);
    // 1 kHz trapezoidal square wave (0..5 V, 25% duty, 50 us rise/fall)
    const period = 1e-3;
    const edge = 5e-5;
    for (let i = 0; i < n; i++) {
      const ti = (i / (n - 1)) * opts.stop;
      t[i] = ti;
      const ph = ti % period;
      if (ph < edge) v[i] = 5 * (ph / edge);
      else if (ph < 0.25 * period) v[i] = 5;
      else if (ph < 0.25 * period + edge) v[i] = 5 * (1 - (ph - 0.25 * period) / edge);
      else v[i] = 0;
    }
    return {
      vectors: { 'V(OUT)': v, 'I(R1)': v.map(x => x / 1000) },
      scale: { name: 'time' as const, values: t },
      log: [],
    };
  }),
  ac: vi.fn(async () => {
    // First-order RC low-pass with fc = 1 kHz across 10 Hz..100 kHz
    const pts = 41;
    const fc = 1000;
    const freqs = new Float64Array(pts);
    const re = new Float64Array(pts);
    const im = new Float64Array(pts);
    const mag = new Float64Array(pts);
    for (let i = 0; i < pts; i++) {
      const f = 10 * Math.pow(10, i / 10);
      freqs[i] = f;
      const r = f / fc;
      const denom = 1 + r * r;
      re[i] = 1 / denom;
      im[i] = -r / denom;
      mag[i] = Math.hypot(re[i]!, im[i]!);
    }
    return {
      vectors: { 'V(OUT)': mag },
      scale: { name: 'frequency' as const, values: freqs },
      complex: { 'V(OUT)': { re, im } },
      log: [],
    };
  }),
}));

vi.mock('@cadllm/sim-mcu', () => {
  const PINS: UnoPinName[] = [
    'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
    'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
    'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
  ];
  class MockUno {
    serial = '';
    time = 0;
    private mode: string;
    private state = new Map<UnoPinName, UnoPinState>();
    private inputs = new Map<UnoPinName, Logic | number>();
    constructor(hex: string) {
      this.mode = hex;
      for (const p of PINS) this.state.set(p, { mode: 'input', level: 'Z' });
      if (this.mode === 'button') this.state.set('D13', { mode: 'output', level: '0' });
    }
    pin(name: UnoPinName): UnoPinState {
      return this.state.get(name)!;
    }
    setInput(name: UnoPinName, level: Logic | number): void {
      this.inputs.set(name, level);
    }
    run(seconds: number, onPinChange?: (t: number, pin: UnoPinName, level: Logic) => void): void {
      const prev = this.time;
      const next = prev + seconds;
      this.time = next;
      if (this.mode === 'blink') {
        const halfIdxPrev = Math.floor(prev);
        const halfIdxNext = Math.floor(next);
        if (prev === 0) {
          this.state.set('D13', { mode: 'output', level: '1' });
          onPinChange?.(1e-5, 'D13', '1');
        } else if (halfIdxNext > halfIdxPrev) {
          const level: Logic = halfIdxNext % 2 === 0 ? '1' : '0';
          this.state.set('D13', { mode: 'output', level });
          onPinChange?.(halfIdxNext, 'D13', level);
        }
      } else if (this.mode === 'button') {
        const d2 = this.inputs.get('D2');
        const hi = typeof d2 === 'number' ? d2 >= 2.5 : d2 === '1';
        const level: Logic = hi ? '1' : '0';
        if (this.state.get('D13')!.level !== level) {
          this.state.set('D13', { mode: 'output', level });
          onPinChange?.(next, 'D13', level);
        }
      }
    }
  }
  return {
    UNO_CLOCK_HZ: 16_000_000,
    compileSketch: vi.fn(async (text: string) => ({
      hex: text.includes('digitalRead') ? 'button' : 'blink',
      size: 100,
      cached: false,
      log: '',
    })),
    Uno: MockUno,
  };
});

const { Engine } = await import('../src/index.ts');
const library = loadLibrary([builtinPartsDir]);

describe('sim summaries and expect measures', () => {
  it('summarizes tran and evaluates all waveform expect measures', async () => {
    const e = new Engine({ library });
    e.edit({ cnl: 'V1 dc_supply 5; R1 res 1k; C1 cap 100n; VCC: V1.+ R1.1; OUT: R1.2 C1.1; GND: V1.- C1.2' });

    const out = await e.sim({
      run: [
        'tran 4m probes=V(OUT),I(R1)',
        'expect V(OUT)@0.1ms > 4.9',
        'expect min(V(OUT)) < 0.1',
        'expect max(V(OUT)) 4.9..5.1',
        'expect avg(V(OUT)) 1.0..1.6',
        'expect rms(V(OUT)) 2.0..2.8',
        'expect final(V(OUT)) < 0.5',
        'expect freq(V(OUT)) 950..1050',
        'expect period(V(OUT)) 0.95m..1.05m',
        'expect duty(V(OUT)) 20%..30%',
        'expect duty(V(OUT)) < 0.3',
        'expect rise(V(OUT)) 30u..50u',
        'expect fall(V(OUT)) 30u..50u',
      ].join('\n'),
    });

    expect(out).toContain('tran 4ms 401pts');
    expect(out).toContain('freq 1kHz');
    expect(out).toContain('PASS duty(V(OUT)) 25% in 20%..30%');
    expect(out).toContain('PASS duty(V(OUT)) 25% < 0.3');
    expect(out.split('\n').filter(l => l.startsWith('PASS '))).toHaveLength(12);
    expect(out).not.toContain('FAIL');
  });

  it('summarizes ac with start/stop gain and -3dB cutoff', async () => {
    const e = new Engine({ library });
    e.edit({ cnl: 'V1 dc_supply 1; R1 res 1k; C1 cap 159n; VCC: V1.+ R1.1; OUT: R1.2 C1.1; GND: V1.- C1.2' });

    const out = await e.sim({
      run: [
        'ac dec 10 10 100k probes=V(OUT)',
        'expect max(V(OUT)) 0.99..1.01',
        'expect V(OUT)@1k 0.7..0.72',
      ].join('\n'),
    });

    expect(out).toContain('ac dec 10Hz..100kHz 41pts');
    expect(out).toContain('-3dB 1kHz');
    expect(out).toContain('PASS max(V(OUT))');
    expect(out).toContain('PASS V(OUT)@1k');
  });

  it('falls back to sim-spice op when parts lack own-solver models', async () => {
    const e = new Engine({ library });
    e.edit({ cnl: 'V1 dc_supply 5; R1 res 1k; Q1 npn; VCC: V1.+ R1.1; OUT: R1.2 Q1.C; GND: V1.- Q1.E' });

    const out = await e.sim({ run: 'dc probes=V(OUT); expect V(OUT) 2.4..2.6' });
    expect(out).toContain('V(OUT) 2.5');
    expect(out).toContain('PASS V(OUT) 2.5 in 2.4..2.6');
  });

  it('runs blink and button-led mixed simulations through Engine.test()', async () => {
    const e = new Engine({ library });
    e.project({ op: 'open', path: 'examples/blink.cnl' });
    const blinkRes = await e.test();
    expect(blinkRes.failed, blinkRes.text).toBe(0);
    expect(blinkRes.text).toContain('PASS "blink 1s"');

    e.project({ op: 'open', path: 'examples/button-led.cnl' });
    const btnRes = await e.test();
    expect(btnRes.failed, btnRes.text).toBe(0);
    expect(btnRes.text).toContain('PASS "button controls led"');
  });
});
