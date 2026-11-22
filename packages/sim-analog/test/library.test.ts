// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { Doc } from '@cadllm/core';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { R_OUT, formatOp, operatingPoint } from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);

describe('@cadllm/library integration', () => {
  it('solves the FOUNDATION §4.7 LED circuit loaded from real parts', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
      tx.addComponent({ ref: 'D1', part: 'led' });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'BAT1.-']);
    });

    const r = operatingPoint(doc.read);
    expect(r.converged).toBe(true);
    expect(r.i.D1!).toBeGreaterThan(0.013);
    expect(r.i.D1!).toBeLessThan(0.0145);
    expect(formatOp(r, ['V(LA)', 'I(D1)'])).toMatch(/^V\(LA\) 1\.9\d\s+I\(D1\) 13\.\dm$/);
  });

  it('solves the FOUNDATION §3.1 mixed NAND + LED circuit loaded from real parts', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW1', part: 'button', props: { state: 'released' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc00' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '330' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.addComponent({ ref: 'TP1', part: 'logic_probe' });
      tx.addComponent({ ref: 'BB1', part: 'breadboard_half' });
      tx.connect('VCC', ['BAT1.+', 'U1.VCC', 'U1.1A', 'SW1.1']);
      tx.connect('IN', ['SW1.2', 'U1.1B', 'R2.1', 'TP1.IN']);
      tx.connect('GND', ['BAT1.-', 'U1.GND', 'D1.K', 'R2.2']);
      tx.connect('Y', ['U1.1Y', 'R1.1', 'BB1.A1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
    });

    const rHigh = operatingPoint(doc.read, { logic: { Y: '1', IN: '0', VCC: '1', GND: '0' } });
    expect(rHigh.converged).toBe(true);
    expect(rHigh.warnings).toEqual([]);
    expect(rHigh.v.LA!).toBeGreaterThan(1.8);
    expect(rHigh.i.D1!).toBeGreaterThan(8e-3);
    expect(rHigh.i.D1!).toBeLessThan(15e-3);
    expect(rHigh.i.D1!).toBeCloseTo((5 - rHigh.v.LA!) / (330 + R_OUT), 6);

    const rLow = operatingPoint(doc.read, { logic: { Y: '0' } });
    expect(rLow.converged).toBe(true);
    expect(Math.abs(rLow.i.D1!)).toBeLessThan(1e-9);

    try {
      operatingPoint(doc.read);
      throw new Error('expected floating-net error');
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain('Y');
      expect(msg).toContain('driven only by U1.1Y: pass logic levels');
    }
  });
});
