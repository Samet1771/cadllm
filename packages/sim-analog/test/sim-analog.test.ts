// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { CadError, Doc } from '@cadllm/core';
import {
  DIODE_1N4148,
  LED_MODELS,
  R_OUT,
  formatOp,
  operatingPoint,
  solveLinear,
  solveNetlist,
  thermalVoltage,
  type LedColor,
} from '../src/index.ts';
import { lib } from './fixtures.ts';

function build(fn: (tx: Parameters<Doc['transact']>[0] extends (tx: infer T) => void ? T : never) => void) {
  const doc = new Doc(lib);
  doc.transact(fn);
  return doc.read;
}

describe('linear circuits & dividers', () => {
  it('solves a 2-resistor voltage divider exact to 1e-9', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '12' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '2k' } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'R2.1']);
      tx.connect('GND', ['R2.2', 'V1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.reference).toBe('GND');
    expect(Math.abs(r.v.VCC! - 12)).toBeLessThan(1e-9);
    expect(Math.abs(r.v.OUT! - 8)).toBeLessThan(1e-9);
    expect(Math.abs(r.v.GND!)).toBe(0);
    expect(Math.abs(r.i.R1! - 4e-3)).toBeLessThan(1e-12);
    expect(Math.abs(r.i.R2! - 4e-3)).toBeLessThan(1e-12);
    expect(Math.abs(r.i.V1! - 4e-3)).toBeLessThan(1e-12);
  });

  it('solves a 3-resistor voltage divider exact to 1e-9', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '9' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '2k' } });
      tx.addComponent({ ref: 'R3', part: 'res', props: { resistance: '3k' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('N_A', ['R1.2', 'R2.1']);
      tx.connect('N_B', ['R2.2', 'R3.1']);
      tx.connect('GND', ['R3.2', 'BAT1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(Math.abs(r.v.N_A! - 7.5)).toBeLessThan(1e-9);
    expect(Math.abs(r.v.N_B! - 4.5)).toBeLessThan(1e-9);
    expect(Math.abs(r.i.BAT1! - 1.5e-3)).toBeLessThan(1e-12);
  });

  it.each([
    ['0', 10 * (10000 / 10000.001)],
    ['0.25', 7.5],
    ['0.5', 5.0],
    ['0.75', 2.5],
    ['1', 10 * (0.001 / 10000.001)],
  ])('solves pot divider at position=%s', (position, expectedV) => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'RV1', part: 'pot', props: { resistance: '10k', position } });
      tx.connect('VCC', ['V1.+', 'RV1.1']);
      tx.connect('WIPER', ['RV1.W']);
      tx.connect('GND', ['RV1.3', 'V1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.WIPER).toBeCloseTo(expectedV, 8);
    expect(r.i['RV1.W']).toBeCloseTo(0, 12);
    expect(r.i.RV1!).toBeGreaterThan(0);
  });

  it('reports loaded pot currents RV1 and RV1.W accurately', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'RV1', part: 'pot', props: { resistance: '10k', position: '0.5' } });
      tx.addComponent({ ref: 'RL', part: 'res', props: { resistance: '5k' } });
      tx.connect('VCC', ['V1.+', 'RV1.1']);
      tx.connect('WIPER', ['RV1.W', 'RL.1']);
      tx.connect('GND', ['RV1.3', 'RL.2', 'V1.-']);
    });
    const r = operatingPoint(q);
    // R1W = 5k, RW3 || RL = 2.5k => VW = 10 * 2.5 / 7.5 = 10/3 V
    const vw = 10 / 3;
    expect(r.v.WIPER).toBeCloseTo(vw, 9);
    expect(r.i.RV1).toBeCloseTo((10 - vw) / 5000, 12);
    // Current INTO wiper is negative because current leaves W into RL
    expect(r.i['RV1.W']).toBeCloseTo(-vw / 5000, 12);
  });

  it('models switch_spst open vs closed and button released vs pressed', () => {
    const runSwitch = (part: 'switch_spst' | 'button', state: string) => {
      const q = build(tx => {
        tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
        tx.addComponent({ ref: 'SW1', part, props: { state } });
        tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
        tx.connect('VCC', ['V1.+', 'SW1.1']);
        tx.connect('OUT', ['SW1.2', 'R1.1']);
        tx.connect('GND', ['R1.2', 'V1.-']);
      });
      return operatingPoint(q);
    };

    const swOpen = runSwitch('switch_spst', 'open');
    expect(swOpen.v.OUT).toBeCloseTo(5 * (1e3 / (1e9 + 1e3)), 10);
    expect(swOpen.i.SW1).toBeCloseTo(5 / (1e9 + 1e3), 15);

    const swClosed = runSwitch('switch_spst', 'closed');
    expect(swClosed.v.OUT).toBeCloseTo(5 * (1000 / 1000.01), 9);

    const btnRel = runSwitch('button', 'released');
    expect(btnRel.v.OUT).toBeLessThan(1e-5);

    const btnPress = runSwitch('button', 'pressed');
    expect(btnPress.v.OUT).toBeGreaterThan(4.999);
  });

  it('treats capacitors as open and inductors as shorts at DC', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'L1', part: 'inductor', props: { inductance: '100u' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'C1', part: 'cap', props: { capacitance: '100n' } });
      tx.connect('VCC', ['V1.+', 'L1.1']);
      tx.connect('MID', ['L1.2', 'R1.1', 'C1.1']);
      tx.connect('GND', ['R1.2', 'C1.2', 'V1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.MID).toBeCloseTo(10, 9);
    expect(r.i.L1).toBeCloseTo(10e-3, 12);
    expect(r.i.C1).toBe(0);
  });
});

describe('nonlinear diodes, LEDs & zeners', () => {
  it('matches FOUNDATION §4.7 LED example (5V, 220Ω, red LED -> ~13-14 mA) and formats concisely', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'BAT1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.i.D1!).toBeGreaterThan(0.013);
    expect(r.i.D1!).toBeLessThan(0.0145);
    expect(r.i.BAT1!).toBeCloseTo(r.i.D1!, 9);

    const formatted = formatOp(r, ['V(LA)', 'I(D1)', 'V(R1.2)']);
    expect(formatted).toMatch(/^V\(LA\) 1\.9\d\s+I\(D1\) 13\.\dm\s+V\(R1\.2\) 1\.9\d$/);
  });

  it('matches series LED current within 2% of hand Shockley calculation & 5V/150Ω ≈ 20mA', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '150' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'BAT1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    const vf = r.v.LA!;
    const vt = thermalVoltage();
    const { is, n } = LED_MODELS.red;
    const handCurrent = is * (Math.exp(vf / (n * vt)) - 1);
    const relErr = Math.abs(r.i.D1! - handCurrent) / handCurrent;
    expect(relErr).toBeLessThan(0.02);
    expect(r.i.D1!).toBeCloseTo(0.02, 3); // ~20 mA
  });

  it.each<[LedColor, number]>([
    ['red', 2.0],
    ['yellow', 2.1],
    ['green', 2.2],
    ['blue', 3.1],
    ['white', 3.1],
  ])('LED color %s hits ≈ %f V at 20 mA', (color, targetVf) => {
    // Use 10 V supply with resistor chosen for ~20 mA: R = (10 - targetVf) / 0.02
    const rVal = String((10 - targetVf) / 0.02);
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: rVal } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('A', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'V1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.A).toBeCloseTo(targetVf, 2);
    expect(r.i.D1).toBeCloseTo(0.02, 4);
  });

  it('1N4148 matches ~0.62 V @ 1 mA and ~0.72 V @ 10 mA and works as diode clamp', () => {
    const res1N4148 = solveNetlist({
      elements: [
        { kind: 'I', ref: 'I1', from: 0, to: 1, current: 1e-3 },
        { kind: 'D', ref: 'D1', anode: 1, cathode: 0, model: DIODE_1N4148 },
      ],
    });
    expect(res1N4148.converged).toBe(true);
    expect(res1N4148.v[1]).toBeCloseTo(0.62, 2);

    const res10m = solveNetlist({
      elements: [
        { kind: 'I', ref: 'I1', from: 0, to: 1, current: 10e-3 },
        { kind: 'D', ref: 'D1', anode: 1, cathode: 0, model: DIODE_1N4148 },
      ],
    });
    expect(res10m.converged).toBe(true);
    expect(res10m.v[1]).toBeCloseTo(0.72, 2);

    // Diode clamp: 5 V input via 1k resistor clamped to 2.5 V rail by 1N4148
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'V2', part: 'dc_supply', props: { voltage: '2.5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'D1', part: 'diode' });
      tx.connect('VIN', ['V1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'D1.A']);
      tx.connect('VCLAMP', ['V2.+', 'D1.K']);
      tx.connect('GND', ['V1.-', 'V2.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.OUT!).toBeGreaterThan(3.08);
    expect(r.v.OUT!).toBeLessThan(3.20);
  });

  it('converges on reverse-biased diode and LED with current ≈ -Is', () => {
    const qDiode = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'D1', part: 'diode' });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('K', ['R1.2', 'D1.K']);
      tx.connect('GND', ['D1.A', 'V1.-']);
    });
    const rd = operatingPoint(qDiode);
    expect(rd.converged).toBe(true);
    expect(rd.i.D1!).toBeCloseTo(-DIODE_1N4148.is, 14);

    const qLed = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('K', ['R1.2', 'D1.K']);
      tx.connect('GND', ['D1.A', 'V1.-']);
    });
    const rl = operatingPoint(qLed);
    expect(rl.converged).toBe(true);
    expect(rl.i.D1!).toBeCloseTo(-LED_MODELS.red.is, 18);
  });

  it('regulates voltage with 5V zener, 9V source, 470Ω resistor -> Vout ≈ 5 V', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '9' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '470' } });
      tx.addComponent({ ref: 'D1', part: 'zener', props: { voltage: '5' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'D1.K']);
      tx.connect('GND', ['D1.A', 'BAT1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.OUT!).toBeGreaterThan(4.95);
    expect(r.v.OUT!).toBeLessThan(5.1);
    expect(r.i.D1!).toBeLessThan(-8e-3); // reverse breakdown current K -> A
  });
});

describe('reference node selection, topology checks, and errors', () => {
  it('picks reference in priority: gnd_symbol > GND name > first V source minus pin', () => {
    // 1) gnd_symbol wins even if another net is named GND
    const qSym = build(tx => {
      tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '5' } });
      tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('VDD', ['VCC1.VCC', 'R1.1']);
      tx.connect('VSS', ['R1.2', 'GND1.GND']);
    });
    const rSym = operatingPoint(qSym);
    expect(rSym.reference).toBe('VSS');
    expect(rSym.v.VDD).toBeCloseTo(5, 9);
    expect(rSym.v.VSS).toBe(0);

    // 2) Case-insensitive GND net wins over V source minus pin
    const qGndName = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('gnd', ['V1.+', 'R1.1']);
      tx.connect('NEG', ['V1.-', 'R1.2']);
    });
    const rGndName = operatingPoint(qGndName);
    expect(rGndName.reference).toBe('gnd');
    expect(rGndName.v.NEG).toBeCloseTo(-5, 9);

    // 3) First V source in natural ref order wins when no GND net/symbol exists (V2 before V10)
    const qVMinus = build(tx => {
      tx.addComponent({ ref: 'V10', part: 'dc_supply', props: { voltage: '3' } });
      tx.addComponent({ ref: 'V2', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('N_A', ['V2.+', 'R1.1']);
      tx.connect('N_B', ['V2.-', 'V10.-', 'R1.2']);
      tx.connect('N_C', ['V10.+']);
    });
    const rVMinus = operatingPoint(qVMinus);
    expect(rVMinus.reference).toBe('N_B');
    expect(rVMinus.v.N_A).toBeCloseTo(5, 9);
    expect(rVMinus.v.N_C).toBeCloseTo(3, 9);
  });

  it('throws clear CadError naming the floating net (including cap-isolated nets)', () => {
    const qCapFloat = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'C1', part: 'cap' });
      tx.addComponent({ ref: 'R1', part: 'res' });
      tx.connect('VCC', ['V1.+', 'C1.1', 'R1.1']);
      tx.connect('ISLAND_NET', ['C1.2']);
      tx.connect('GND', ['V1.-', 'R1.2']);
    });
    expect(() => operatingPoint(qCapFloat)).toThrowError(CadError);
    expect(() => operatingPoint(qCapFloat)).toThrow(/ISLAND_NET/);
  });

  it('throws clear CadError naming components in ideal voltage-source / inductor loops', () => {
    const qLoop = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'L1', part: 'inductor' });
      tx.connect('VCC', ['V1.+', 'L1.1']);
      tx.connect('GND', ['V1.-', 'L1.2']);
    });
    expect(() => operatingPoint(qLoop)).toThrowError(CadError);
    expect(() => operatingPoint(qLoop)).toThrow(/L1/);
    expect(() => operatingPoint(qLoop)).toThrow(/V1/);
  });

  it('throws clear CadError naming the offending net/row on singular matrices', () => {
    const a = new Float64Array([1, 0, 0, 0]);
    const b = new Float64Array([1, 0]);
    expect(() => solveLinear(a, b, 2, ['net VCC', 'net SINGULAR_NODE'], ['net VCC', 'net SINGULAR_NODE'])).toThrow(
      /SINGULAR_NODE/,
    );
  });

  it('rejects unsupported SPICE parts by name instead of silently ignoring them', () => {
    for (const [ref, part] of [['Q1', 'npn'], ['Q2', 'pnp'], ['M1', 'nmos'], ['U1', 'ne555'], ['U2', 'lm358']] as const) {
      const q = build(tx => {
        tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
        tx.addComponent({ ref, part });
        tx.connect('VCC', ['V1.+']);
        tx.connect('GND', ['V1.-']);
      });
      expect(() => operatingPoint(q)).toThrow(new RegExp(ref));
    }
  });
});

describe('mixed digital-analog bridge & non-spice parts', () => {
  const buildNandLed = () => build(tx => {
    tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
    tx.addComponent({ ref: 'SW1', part: 'button', props: { state: 'released' } });
    tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' } });
    tx.addComponent({ ref: 'U1', part: '74hc00' });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '330' } });
    tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
    tx.connect('VCC', ['BAT1.+', 'U1.VCC', 'U1.1A', 'SW1.1']);
    tx.connect('IN', ['SW1.2', 'U1.1B', 'R2.1']);
    tx.connect('GND', ['BAT1.-', 'U1.GND', 'D1.K', 'R2.2']);
    tx.connect('Y', ['U1.1Y', 'R1.1']);
    tx.connect('LA', ['R1.2', 'D1.A']);
  });

  it('bridges FOUNDATION §3.1 NAND circuit with logic high, logic low, and undriven hint', () => {
    const q = buildNandLed();

    const rHigh = operatingPoint(q, { logic: { Y: '1', IN: '0', VCC: '1', GND: '0' } });
    expect(rHigh.converged).toBe(true);
    expect(rHigh.warnings).toEqual([]);
    expect(rHigh.v.LA!).toBeGreaterThan(1.8);
    expect(rHigh.i.D1!).toBeGreaterThan(8e-3);
    expect(rHigh.i.D1!).toBeLessThan(15e-3);
    expect(rHigh.i.D1!).toBeCloseTo((5 - rHigh.v.LA!) / (330 + R_OUT), 6);

    const rLow = operatingPoint(q, { logic: { Y: '0' } });
    expect(rLow.converged).toBe(true);
    expect(rLow.warnings).toEqual([]);
    expect(Math.abs(rLow.i.D1!)).toBeLessThan(1e-9);
    expect(rLow.v.LA!).toBeCloseTo(0, 6);

    expect(() => operatingPoint(q)).toThrow(/floating/i);
    expect(() => operatingPoint(q)).toThrow(/Y/);
    try {
      operatingPoint(q);
    } catch (e) {
      expect(String(e)).toContain('driven only by U1.1Y: pass logic levels');
    }
  });

  it('handles tristate X/Z with warning, unconnected IC VCC/GND, logic_probe, buzzer, and boards', () => {
    // Tristate Z/X on 74hc595 output with pull-down resistor still solves and emits one warning
    const qTri = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: '74hc595' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'TP1', part: 'logic_probe' });
      tx.addComponent({ ref: 'BZ1', part: 'buzzer' });
      tx.addComponent({ ref: 'BB1', part: 'breadboard_half' });
      tx.addComponent({ ref: 'A1', part: 'arduino_uno' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'BZ1.+', 'A1.5V']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'R1.2', 'BZ1.-', 'A1.GND']);
      tx.connect('Q0', ['U1.Q0', 'R1.1', 'TP1.IN', 'BB1.A1']);
    });
    const rTri = operatingPoint(qTri, { logic: { Q0: 'Z' } });
    expect(rTri.converged).toBe(true);
    expect(rTri.v.Q0).toBeCloseTo(0, 9);
    expect(rTri.warnings).toContain('BZ1: no analog model, treated as open');
    expect(rTri.warnings.some(w => w.startsWith('U1:'))).toBe(true);
    expect(rTri.warnings.some(w => w.includes('TP1') || w.includes('BB1') || w.includes('A1'))).toBe(false);

    // Unconnected IC VCC/GND gives no output stamps and warns
    const qNoPwr = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: '74hc00' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
      tx.connect('VCC', ['V1.+']);
      tx.connect('GND', ['V1.-', 'R1.2']);
      tx.connect('Y', ['U1.1Y', 'R1.1']);
    });
    const rNoPwr = operatingPoint(qNoPwr, { logic: { Y: '1' } });
    expect(rNoPwr.v.Y).toBeCloseTo(0, 9);
    expect(rNoPwr.warnings.some(w => w.includes('U1') && w.includes('VCC/GND'))).toBe(true);
  });
});

describe('lower-level netlist solver, convergence & determinism', () => {
  it('solves current source into a resistor and diode with series resistance', () => {
    const r = solveNetlist({
      elements: [
        { kind: 'I', ref: 'I1', from: 0, to: 1, current: 5e-3 },
        { kind: 'R', ref: 'R1', a: 1, b: 0, resistance: 2e3 },
      ],
    });
    expect(r.converged).toBe(true);
    expect(r.v[1]).toBeCloseTo(10, 9);
    expect(r.i.I1).toBe(5e-3);
    expect(r.i.R1).toBeCloseTo(5e-3, 9);

    const rDiodeRs = solveNetlist({
      elements: [
        { kind: 'V', ref: 'V1', pos: 1, neg: 0, voltage: 5 },
        { kind: 'D', ref: 'D1', anode: 1, cathode: 2, model: { ...DIODE_1N4148, rs: 10 } },
        { kind: 'R', ref: 'R1', a: 2, b: 0, resistance: 430 },
      ],
    });
    expect(rDiodeRs.converged).toBe(true);
    expect(rDiodeRs.i.D1).toBeCloseTo(rDiodeRs.i.R1!, 9);
    expect(rDiodeRs.v[1]! - rDiodeRs.v[2]!).toBeGreaterThan(0.75); // shockley + 10Ω*I drop
  });

  it('reports converged=false with reason when maxIter is exceeded instead of throwing', () => {
    const r = solveNetlist(
      {
        elements: [
          { kind: 'V', ref: 'V1', pos: 1, neg: 0, voltage: 5 },
          { kind: 'R', ref: 'R1', a: 1, b: 2, resistance: 150 },
          { kind: 'D', ref: 'D1', anode: 2, cathode: 0, model: LED_MODELS.red },
        ],
      },
      { maxIter: 1 },
    );
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(1);
    expect(r.reason).toBeTruthy();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('produces deterministic results and key ordering independent of insertion order', () => {
    const q1 = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('GND', ['D1.K', 'BAT1.-']);
    });

    const q2 = build(tx => {
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
      tx.connect('GND', ['D1.K', 'BAT1.-']);
      tx.connect('LA', ['R1.2', 'D1.A']);
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
    });

    const r1 = operatingPoint(q1);
    const r2 = operatingPoint(q2);
    expect(r1).toEqual(r2);
    expect(Object.keys(r1.v)).toEqual(Object.keys(r2.v));
    expect(Object.keys(r1.i)).toEqual(Object.keys(r2.i));
    expect(formatOp(r1)).toBe(formatOp(r2));
  });

  it('handles pot rheostat mode (unconnected pin 3), cap_pol, unconnected parts, and temperature option', () => {
    const qRheo = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'RV1', part: 'pot', props: { resistance: '10k', position: '0.4' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '6k' } });
      tx.addComponent({ ref: 'C1', part: 'cap_pol', props: { capacitance: '10u' } });
      tx.addComponent({ ref: 'R_SPARE', part: 'res' });
      tx.connect('VCC', ['V1.+', 'RV1.1', 'C1.+']);
      tx.connect('MID', ['RV1.W', 'R1.1']);
      tx.connect('GND', ['R1.2', 'C1.-', 'V1.-']);
    });
    const r = operatingPoint(qRheo);
    expect(r.converged).toBe(true);
    // R1W = 0.4 * 10k = 4k, in series with R1 = 6k => V(MID) = 6 V
    expect(r.v.MID).toBeCloseTo(6, 9);
    expect(r.i.RV1).toBeCloseTo(1e-3, 12);
    expect(r.i['RV1.W']).toBeCloseTo(-1e-3, 12);
    expect(r.i.C1).toBe(0);
    expect(r.i.R_SPARE).toBe(0);
    expect(r.warnings.some(w => w.includes('RV1.3'))).toBe(true);
    expect(r.warnings.some(w => w.includes('R_SPARE'))).toBe(true);

    // Temperature shifts diode Vf (higher T lowers Vf at constant I because Is is fixed here, wait: Vf = n*Vt*ln(I/Is) increases linearly with T when Is is fixed!)
    const rCold = solveNetlist(
      { elements: [{ kind: 'I', ref: 'I1', from: 0, to: 1, current: 1e-3 }, { kind: 'D', ref: 'D1', anode: 1, cathode: 0, model: DIODE_1N4148 }] },
      { temp: 250 },
    );
    const rHot = solveNetlist(
      { elements: [{ kind: 'I', ref: 'I1', from: 0, to: 1, current: 1e-3 }, { kind: 'D', ref: 'D1', anode: 1, cathode: 0, model: DIODE_1N4148 }] },
      { temp: 350 },
    );
    expect(rHot.v[1]!).not.toBeCloseTo(rCold.v[1]!, 3);
  });

  it('rejects floating current-source islands and VSYM shorted to GND', () => {
    expect(() =>
      solveNetlist({
        elements: [{ kind: 'I', ref: 'I1', from: 0, to: 1, current: 1e-3 }],
        nodeNames: { 0: 'GND', 1: 'OPEN_ISLAND' },
      }),
    ).toThrow(/OPEN_ISLAND/);

    const qVsymLoop = build(tx => {
      tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '5' } });
      tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
      tx.connect('GND', ['VCC1.VCC', 'GND1.GND']);
    });
    expect(() => operatingPoint(qVsymLoop)).toThrow(/VCC1/);
  });

  it('converges on multi-diode series string and supports formatOp probes & aliases', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '12' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'D1', part: 'diode' });
      tx.addComponent({ ref: 'D2', part: 'diode' });
      tx.addComponent({ ref: 'D3', part: 'diode' });
      tx.addComponent({ ref: 'D4', part: 'led', props: { color: 'blue' } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('N1', ['R1.2', 'D1.A']);
      tx.connect('N2', ['D1.K', 'D2.A']);
      tx.connect('N3', ['D2.K', 'D3.A']);
      tx.connect('N4', ['D3.K', 'D4.A']);
      tx.connect('GND', ['D4.K', 'V1.-']);
    });
    const r = operatingPoint(q);
    expect(r.converged).toBe(true);
    expect(r.v.N4!).toBeGreaterThan(2.5);
    expect(r.i.D4!).toBeCloseTo(r.i.R1!, 9);

    const out = formatOp(r, ['V(n4)', 'v(D4.anode)', 'i(d4)']);
    expect(out).toContain('V(n4) 3');
    expect(out).toContain('V(D4.anode) 3');
    expect(out).toContain('I(d4) 6.89m');
    expect(formatOp(r)).toContain('V(VCC) 12');
  });

  it('covers formatOp error cases and SI prefix formatting across magnitudes', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '100meg' } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('GND', ['V1.-', 'R1.2']);
    });
    const r = operatingPoint(q);
    expect(formatOp(r, ['I(R1)'])).toBe('I(R1) 100n');
    expect(() => formatOp(r, ['X(VCC)'])).toThrow(CadError);
    expect(() => formatOp(r, ['V(MISSING)'])).toThrow(/MISSING/);
    expect(() => formatOp({ ...r, v: { ...r.v } }, ['V(R1.1)'])).toThrow(/Query/);
  });

  it('converges via continuation on high-voltage nonlinear diode bridge', () => {
    // Full-wave bridge rectifier driven by 20 V DC source with 1k load
    const r = solveNetlist({
      elements: [
        { kind: 'V', ref: 'V1', pos: 1, neg: 2, voltage: 20 },
        { kind: 'D', ref: 'D1', anode: 1, cathode: 3, model: DIODE_1N4148 },
        { kind: 'D', ref: 'D2', anode: 2, cathode: 3, model: DIODE_1N4148 },
        { kind: 'D', ref: 'D3', anode: 0, cathode: 1, model: DIODE_1N4148 },
        { kind: 'D', ref: 'D4', anode: 0, cathode: 2, model: DIODE_1N4148 },
        { kind: 'R', ref: 'RL', a: 3, b: 0, resistance: 1e3 },
      ],
    });
    expect(r.converged).toBe(true);
    // Node 1 = +10 - ~0, Node 2 = -10... wait: D1 (1->3) and D4 (0->2) forward conduct: V(3) ≈ 20 - 2*Vf ≈ 18.5 V
    expect(r.v[3]!).toBeGreaterThan(18.3);
    expect(r.v[3]!).toBeLessThan(18.8);
    expect(r.i.D1!).toBeCloseTo(r.i.RL!, 8);
    expect(r.i.D4!).toBeCloseTo(r.i.RL!, 8);
    expect(r.i.D2!).toBeCloseTo(-DIODE_1N4148.is, 13);
    expect(r.i.D3!).toBeCloseTo(-DIODE_1N4148.is, 13);
  });
});
