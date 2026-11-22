// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Doc } from '@cadllm/core';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { clockStimulus, formatTransitions, simulate } from '../src/index.ts';

describe('2-bit ripple counter with real @cadllm/library parts', () => {
  it('clears Q1Q0 to 00 during async CLR reset and counts 00->01->10->11->00', () => {
    const lib = loadLibrary([builtinPartsDir]);
    const ctr = new Doc(lib);
    ctr.transact(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW1', part: 'button' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'SW2', part: 'button' });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc74' });
      tx.connect('VCC', ['BAT1.+', 'U1.VCC', 'U1.1PRE', 'U1.2PRE', 'SW1.1', 'R2.2']);
      tx.connect('GND', ['BAT1.-', 'U1.GND', 'R1.2', 'SW2.2']);
      tx.connect('CLK', ['SW1.2', 'R1.1', 'U1.1CLK']);
      tx.connect('Q0', ['U1.1Q']);
      tx.connect('Q0N', ['U1.1QN', 'U1.1D', 'U1.2CLK']);
      tx.connect('Q1', ['U1.2Q']);
      tx.connect('Q1N', ['U1.2QN', 'U1.2D']);
      tx.connect('RST', ['U1.1CLR', 'U1.2CLR', 'R2.1', 'SW2.1']);
    });

    const stim = [
      { t: 0.1e-6, ref: 'SW2', state: 'pressed' },
      { t: 0.5e-6, ref: 'SW2', state: 'released' },
      ...clockStimulus('SW1', 1e-6, 5, 1e-6),
    ];

    // During held reset (after 10ns prop delay at 110n until 500n): Q1Q0 = 00 and Q1NQ0N = 11
    const duringReset = simulate(ctr.read, { until: 400e-9, stimulus: stim });
    expect(duringReset.final.RST).toBe('0');
    expect(duringReset.final.Q1).toBe('0');
    expect(duringReset.final.Q0).toBe('0');
    expect(duringReset.final.Q1N).toBe('1');
    expect(duringReset.final.Q0N).toBe('1');

    // Full run across 5 clocks starting at 1u:
    // 1.01u -> 01, 2.02u -> 10, 3.01u -> 11, 4.02u -> 00, 5.01u -> 01
    const full = simulate(ctr.read, { until: 10e-6, stimulus: stim });
    expect(full.settled).toBe(true);
    expect(full.warnings).toEqual([]);

    const sampleAt = (t: number): string => {
      let q1 = 'Z';
      let q0 = 'Z';
      for (const ch of full.changes) {
        if (ch.t > t) break;
        if (ch.net === 'Q1') q1 = ch.v;
        if (ch.net === 'Q0') q0 = ch.v;
      }
      return `${q1}${q0}`;
    };

    expect(sampleAt(120e-9)).toBe('00');
    expect(sampleAt(600e-9)).toBe('00');
    expect(sampleAt(1.5e-6)).toBe('01');
    expect(sampleAt(2.5e-6)).toBe('10');
    expect(sampleAt(3.5e-6)).toBe('11');
    expect(sampleAt(4.5e-6)).toBe('00');
    expect(sampleAt(5.5e-6)).toBe('01');

    const table = formatTransitions(full, ['CLK', 'RST', 'Q1', 'Q0']);
    expect(table).toContain('110n  0   0   0  0');
  });
});
