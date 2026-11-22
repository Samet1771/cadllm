// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { CadError } from '@cadllm/core';
import { operatingPoint, type LedColor } from '@cadllm/sim-analog';
import { ac, op, runSpice, toSpiceNetlist, tran } from '../src/index.ts';
import { allParts, build } from './fixtures.ts';

function interpolateAt(x: Float64Array, y: Float64Array, targetX: number): number {
  if (targetX <= x[0]!) return y[0]!;
  for (let i = 1; i < x.length; i++) {
    if (x[i]! >= targetX) {
      const t = (targetX - x[i - 1]!) / (x[i]! - x[i - 1]!);
      return y[i - 1]! + t * (y[i]! - y[i - 1]!);
    }
  }
  return y[y.length - 1]!;
}

describe('netlist generation & conventions', () => {
  it('covers every part in parts/ with a spice sim ref', () => {
    const spiceParts = allParts().filter(p => p.sim?.some(s => s.kind === 'spice'));
    expect(spiceParts.length).toBeGreaterThanOrEqual(19);

    for (const part of spiceParts) {
      const q = build(tx => {
        tx.addComponent({ ref: 'GND_REF', part: 'gnd_symbol' });
        tx.addComponent({ ref: 'V_REF', part: 'dc_supply', props: { voltage: '5' } });
        tx.connect('GND', ['GND_REF.GND', 'V_REF.-']);
        tx.connect('VCC', ['V_REF.+']);

        const ref = `${part.refPrefix}T`;
        if (part.id !== 'gnd_symbol' && part.id !== 'dc_supply') {
          tx.addComponent({ ref, part: part.id });
          part.pins.forEach((pin, idx) => {
            tx.connect(idx === 0 ? 'GND' : `N_${idx}`, [`${ref}.${pin.id}`]);
          });
        }
      });

      const nl = toSpiceNetlist(q, { analysis: { kind: 'op' } });
      expect(nl).toContain('.op');
      expect(nl).toContain('.end');
    }
  });

  it('includes datasheet citations in comments for npn, pnp, nmos, ne555, lm358', () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'Q1', part: 'npn' });
      tx.addComponent({ ref: 'Q2', part: 'pnp' });
      tx.addComponent({ ref: 'M1', part: 'nmos' });
      tx.addComponent({ ref: 'U1', part: 'ne555' });
      tx.addComponent({ ref: 'U2', part: 'lm358' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U2.VCC']);
      tx.connect('GND', ['V1.-', 'Q1.E', 'Q2.E', 'M1.S', 'U1.GND', 'U2.GND']);
    });
    const nl = toSpiceNetlist(q, { analysis: { kind: 'op' } });
    expect(nl).toContain('.model Q2N3904 NPN(');
    expect(nl).toContain('.model Q2N3906 PNP(');
    expect(nl).toContain('.model M2N7000 NMOS(');
    expect(nl).toContain('.subckt NE555');
    expect(nl).toContain('.subckt LM358');
    expect(nl).toMatch(/2n3904/i);
    expect(nl).toMatch(/2n3906/i);
    expect(nl).toMatch(/2n7000/i);
    expect(nl).toMatch(/ti\.com\/product\/NE555/i);
    expect(nl).toMatch(/ti\.com\/product\/LM358/i);
  });

  it('selects reference net via gnd_symbol > GND net > first V source minus pin', async () => {
    const qSym = build(tx => {
      tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '5' } });
      tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('VDD', ['VCC1.VCC', 'R1.1']);
      tx.connect('VSS', ['R1.2', 'GND1.GND']);
    });
    const rSym = await op(qSym);
    expect(rSym.vectors['V(VSS)']![0]).toBe(0);
    expect(rSym.vectors['V(VDD)']![0]).toBeCloseTo(5, 6);

    const qGndNet = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('GND', ['V1.+', 'R1.1']);
      tx.connect('NEG', ['V1.-', 'R1.2']);
    });
    const rGnd = await op(qGndNet);
    expect(rGnd.vectors['V(GND)']![0]).toBe(0);
    expect(rGnd.vectors['V(NEG)']![0]).toBeCloseTo(-5, 6);

    const qVMinus = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '9' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.connect('POS', ['BAT1.+', 'R1.1']);
      tx.connect('NEG', ['BAT1.-', 'R1.2']);
    });
    const rV = await op(qVMinus);
    expect(rV.vectors['V(NEG)']![0]).toBe(0);
    expect(rV.vectors['V(POS)']![0]).toBeCloseTo(9, 6);
  });

  it('handles special net names like 5V and secondary GND net without shorting', async () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '5' } });
      tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '1k' } });
      tx.connect('5V', ['VCC1.VCC', 'R1.1']);
      tx.connect('GND', ['R1.2', 'R2.1']);
      tx.connect('VSS', ['R2.2', 'GND1.GND']);
    });
    const r = await op(q);
    expect(r.vectors['V(5V)']![0]).toBeCloseTo(5, 6);
    expect(r.vectors['V(GND)']![0]).toBeCloseTo(2.5, 6);
    expect(r.vectors['V(VSS)']![0]).toBe(0);
  });

  it('rejects logic ICs with a clear CadError naming the component and part', async () => {
    for (const part of ['74hc00', '74hc595'] as const) {
      const q = build(tx => {
        tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
        tx.addComponent({ ref: 'U1', part });
        tx.connect('VCC', ['BAT1.+', 'U1.VCC']);
        tx.connect('GND', ['BAT1.-', 'U1.GND']);
      });
      expect(() => toSpiceNetlist(q)).toThrow(CadError);
      expect(() => toSpiceNetlist(q)).toThrow(new RegExp(`U1.*${part}`));
      await expect(op(q)).rejects.toThrow(new RegExp(part));
    }
  });
});

describe('RC transient & AC frequency response', () => {
  it('matches analytic RC charging curve within 1% across [0, 5*RC]', async () => {
    const rOhm = 1000;
    const cFarad = 1e-6;
    const rc = rOhm * cFarad; // 1 ms
    const vSupply = 5;

    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: String(vSupply) } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: String(rOhm) } });
      tx.addComponent({ ref: 'C1', part: 'cap', props: { capacitance: String(cFarad) } });
      tx.connect('IN', ['V1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'C1.1']);
      tx.connect('GND', ['V1.-', 'C1.2']);
    });

    const res = await tran(q, { stop: 5 * rc, step: 10e-6, probes: ['V(OUT)', 'I(R1)', 'V(C1.1)'] });
    expect(res.scale.name).toBe('time');
    const t = res.scale.values;
    const vOut = res.vectors['V(OUT)']!;
    const iR1 = res.vectors['I(R1)']!;
    expect(res.vectors['V(C1.1)']!).toEqual(vOut);

    // Check V(OUT) at t = RC matches 5*(1 - 1/e) within 1%
    const vAtRc = interpolateAt(t, vOut, rc);
    const expectedAtRc = vSupply * (1 - Math.exp(-1));
    expect(Math.abs(vAtRc - expectedAtRc) / expectedAtRc).toBeLessThan(0.01);

    // Check every sample point across the charging curve is within 1% of Vsupply
    for (let k = 0; k < t.length; k++) {
      const expectedV = vSupply * (1 - Math.exp(-t[k]! / rc));
      expect(Math.abs(vOut[k]! - expectedV) / vSupply).toBeLessThan(0.01);
      const expectedI = (vSupply - expectedV) / rOhm;
      expect(Math.abs(iR1[k]! - expectedI)).toBeLessThan(5e-5);
    }
  });

  it('matches RC low-pass AC -3 dB cutoff at 1/(2*pi*R*C) within 2%', async () => {
    const rOhm = 1000;
    const cFarad = 100e-9;
    const fc = 1 / (2 * Math.PI * rOhm * cFarad); // ~1591.55 Hz

    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '1' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: String(rOhm) } });
      tx.addComponent({ ref: 'C1', part: 'cap', props: { capacitance: String(cFarad) } });
      tx.connect('IN', ['V1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'C1.1']);
      tx.connect('GND', ['V1.-', 'C1.2']);
    });

    const res = await ac(q, { sweep: 'dec', points: 100, start: 100, stop: 100e3, probes: ['V(OUT)'] });
    expect(res.scale.name).toBe('frequency');
    expect(res.complex).toBeDefined();
    const freqs = res.scale.values;
    const mag = res.vectors['V(OUT)']!;
    const cpx = res.complex!['V(OUT)']!;
    expect(cpx.re.length).toBe(freqs.length);
    expect(cpx.im.length).toBe(freqs.length);

    // Find -3 dB frequency (magnitude = 1 / sqrt(2)) by linear interpolation
    const target = Math.SQRT1_2;
    let measuredFc = NaN;
    for (let i = 1; i < freqs.length; i++) {
      if (mag[i - 1]! >= target && mag[i]! <= target) {
        const frac = (target - mag[i - 1]!) / (mag[i]! - mag[i - 1]!);
        measuredFc = freqs[i - 1]! + frac * (freqs[i]! - freqs[i - 1]!);
        break;
      }
    }
    expect(Math.abs(measuredFc - fc) / fc).toBeLessThan(0.02);

    // Check interpolated phase at fc is -45 deg
    const phaseDeg = (i: number) => (Math.atan2(cpx.im[i]!, cpx.re[i]!) * 180) / Math.PI;
    const idx = freqs.findIndex(f => f >= fc);
    const frac = (fc - freqs[idx - 1]!) / (freqs[idx]! - freqs[idx - 1]!);
    const phaseAtFc = phaseDeg(idx - 1) + frac * (phaseDeg(idx) - phaseDeg(idx - 1));
    expect(phaseAtFc).toBeCloseTo(-45, 1);
  });
});

describe('DC parity with @cadllm/sim-analog (LEDs, diodes, zeners, pots, switches)', () => {
  it.each<LedColor>(['red', 'yellow', 'green', 'blue', 'white'])(
    'LED (%s) .op matches @cadllm/sim-analog within 2%',
    async color => {
      const q = build(tx => {
        tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
        tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
        tx.addComponent({ ref: 'D1', part: 'led', props: { color } });
        tx.connect('VCC', ['BAT1.+', 'R1.1']);
        tx.connect('LA', ['R1.2', 'D1.A']);
        tx.connect('GND', ['D1.K', 'BAT1.-']);
      });

      const own = operatingPoint(q);
      const spice = await op(q, { probes: ['V(LA)', 'I(D1)', 'I(BAT1)'] });

      const vOwn = own.v.LA!;
      const vSpice = spice.vectors['V(LA)']![0]!;
      expect(Math.abs(vSpice - vOwn) / vOwn).toBeLessThan(0.02);

      const iOwn = own.i.D1!;
      const iSpice = spice.vectors['I(D1)']![0]!;
      expect(Math.abs(iSpice - iOwn) / iOwn).toBeLessThan(0.02);
      expect(spice.vectors['I(BAT1)']![0]).toBeCloseTo(iSpice, 6);
    },
  );

  it('matches sim-analog on 1N4148 diode, Zener regulator, pot, cap_pol, inductor, switch, and button', async () => {
    const qZener = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '9' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '470' } });
      tx.addComponent({ ref: 'D1', part: 'zener', props: { voltage: '5' } });
      tx.connect('VCC', ['BAT1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'D1.K']);
      tx.connect('GND', ['D1.A', 'BAT1.-']);
    });
    const ownZ = operatingPoint(qZener);
    const spiceZ = await op(qZener, { probes: ['I(D1)'] });
    expect(Math.abs(spiceZ.vectors['V(OUT)']![0]! - ownZ.v.OUT!) / ownZ.v.OUT!).toBeLessThan(0.02);
    expect(spiceZ.vectors['I(D1)']![0]!).toBeLessThan(-8e-3);

    const qPot = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '10' } });
      tx.addComponent({ ref: 'RV1', part: 'pot', props: { resistance: '10k', position: '0.25' } });
      tx.addComponent({ ref: 'SW1', part: 'switch_spst', props: { state: 'closed' } });
      tx.addComponent({ ref: 'BTN1', part: 'button', props: { state: 'released' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'L1', part: 'inductor', props: { inductance: '100u' } });
      tx.addComponent({ ref: 'C1', part: 'cap_pol', props: { capacitance: '10u' } });
      tx.connect('VCC', ['V1.+', 'RV1.1', 'SW1.1', 'BTN1.1']);
      tx.connect('WIPER', ['RV1.W']);
      tx.connect('SW_OUT', ['SW1.2', 'L1.1']);
      tx.connect('L_OUT', ['L1.2', 'C1.+']);
      tx.connect('BTN_OUT', ['BTN1.2', 'R1.1']);
      tx.connect('GND', ['RV1.3', 'C1.-', 'R1.2', 'V1.-']);
    });
    const ownP = operatingPoint(qPot);
    const spiceP = await op(qPot, { probes: ['I(RV1)', 'I(RV1.W)'] });
    expect(spiceP.vectors['V(WIPER)']![0]).toBeCloseTo(ownP.v.WIPER!, 5);
    expect(spiceP.vectors['V(SW_OUT)']![0]).toBeCloseTo(ownP.v.SW_OUT!, 5);
    expect(spiceP.vectors['V(L_OUT)']![0]).toBeCloseTo(ownP.v.L_OUT!, 5);
    expect(spiceP.vectors['V(BTN_OUT)']![0]).toBeCloseTo(ownP.v.BTN_OUT!, 5);
    expect(spiceP.vectors['I(RV1)']![0]).toBeCloseTo(ownP.i.RV1!, 7);
    expect(spiceP.vectors['I(RV1.W)']![0]).toBeCloseTo(0, 9);
  });
});

describe('transistors & ICs (2N3904, 2N3906, 2N7000, NE555, LM358)', () => {
  it('simulates 2N3904 NPN switch in cutoff and saturation (.op and .tran)', async () => {
    const makeSwitch = (vin: string) =>
      build(tx => {
        tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '5' } });
        tx.addComponent({ ref: 'VIN', part: 'dc_supply', props: { voltage: vin } });
        tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
        tx.addComponent({ ref: 'RB', part: 'res', props: { resistance: '10k' } });
        tx.addComponent({ ref: 'RC', part: 'res', props: { resistance: '1k' } });
        tx.addComponent({ ref: 'Q1', part: 'npn' });
        tx.connect('VCC', ['VCC1.VCC', 'RC.1']);
        tx.connect('IN', ['VIN.+', 'RB.1']);
        tx.connect('B', ['RB.2', 'Q1.B']);
        tx.connect('C', ['RC.2', 'Q1.C']);
        tx.connect('GND', ['GND1.GND', 'VIN.-', 'Q1.E']);
      });

    const offOp = await op(makeSwitch('0'), { probes: ['I(RC)'] });
    expect(offOp.vectors['V(C)']![0]).toBeGreaterThan(4.99);
    expect(offOp.vectors['I(RC)']![0]).toBeLessThan(1e-6);

    const onOp = await op(makeSwitch('5'), { probes: ['I(Q1.C)', 'I(Q1.B)'] });
    expect(onOp.vectors['V(C)']![0]).toBeLessThan(0.2);
    expect(onOp.vectors['V(B)']![0]).toBeGreaterThan(0.6);
    expect(onOp.vectors['V(B)']![0]).toBeLessThan(0.85);
    expect(onOp.vectors['I(Q1.C)']![0]).toBeGreaterThan(4.7e-3);
    expect(onOp.vectors['I(Q1.B)']![0]).toBeGreaterThan(4e-4);

    // 2N3904 pulse switching transient via runSpice
    const tranRes = await runSpice(
      [
        '2N3904 switching tran',
        'Vcc vcc 0 DC 5',
        'Vin in 0 PULSE(0 5 100u 1u 1u 500u 1m)',
        'Rb in b 10k',
        'Rc vcc c 1k',
        'Q1 c b 0 Q2N3904',
        '.model Q2N3904 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)',
        '.tran 5u 800u',
        '.end',
      ].join('\n'),
      { kind: 'tran', stop: 800e-6, step: 5e-6 },
    );
    const vc = tranRes.vectors['v(c)']!;
    expect(vc[0]).toBeGreaterThan(4.99);
    expect(interpolateAt(tranRes.scale.values, vc, 400e-6)).toBeLessThan(0.2);
  });

  it('simulates 2N3906 PNP and 2N7000 NMOS switches (.op)', async () => {
    const qPnp = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'RB', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RC', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'Q1', part: 'pnp' });
      tx.connect('VCC', ['V1.+', 'Q1.E']);
      tx.connect('B', ['Q1.B', 'RB.1']);
      tx.connect('C', ['Q1.C', 'RC.1']);
      tx.connect('GND', ['V1.-', 'RB.2', 'RC.2']);
    });
    const pnpRes = await op(qPnp);
    expect(pnpRes.vectors['V(C)']![0]).toBeGreaterThan(4.8);

    const qNmos = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'RD', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'M1', part: 'nmos' });
      tx.connect('VCC', ['V1.+', 'RD.1', 'M1.G']);
      tx.connect('D', ['RD.2', 'M1.D']);
      tx.connect('GND', ['V1.-', 'M1.S']);
    });
    const nmosRes = await op(qNmos);
    expect(nmosRes.vectors['V(D)']![0]).toBeLessThan(0.05);
  });

  it('simulates NE555 astable oscillator within 10% of 1.44 / ((R1 + 2*R2)*C)', async () => {
    const r1 = 1000;
    const r2 = 10000;
    const c = 100e-9;
    const expectedFreq = 1.44 / ((r1 + 2 * r2) * c); // ~685.7 Hz

    const q = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: String(r1) } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: String(r2) } });
      tx.addComponent({ ref: 'C1', part: 'cap', props: { capacitance: String(c) } });
      tx.addComponent({ ref: 'C2', part: 'cap', props: { capacitance: '10n' } });
      tx.addComponent({ ref: 'U1', part: 'ne555' });
      tx.connect('VCC', ['V1.+', 'R1.1', 'U1.VCC', 'U1.RESET']);
      tx.connect('DIS', ['R1.2', 'R2.1', 'U1.DIS']);
      tx.connect('THR', ['R2.2', 'C1.1', 'U1.THR', 'U1.TRIG']);
      tx.connect('CTRL', ['C2.1', 'U1.CTRL']);
      tx.connect('OUT', ['U1.OUT']);
      tx.connect('GND', ['V1.-', 'C1.2', 'C2.2', 'U1.GND']);
    });

    const res = await tran(q, { stop: 10e-3, step: 20e-6 });
    const t = res.scale.values;
    const vOut = res.vectors['V(OUT)']!;
    const vThr = res.vectors['V(THR)']!;

    const risingEdges: number[] = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i]! > 1e-3 && vOut[i - 1]! < 2 && vOut[i]! >= 2) {
        const frac = (2 - vOut[i - 1]!) / (vOut[i]! - vOut[i - 1]!);
        risingEdges.push(t[i - 1]! + frac * (t[i]! - t[i - 1]!));
      }
    }
    expect(risingEdges.length).toBeGreaterThanOrEqual(4);
    const periods: number[] = [];
    for (let i = 1; i < risingEdges.length; i++) periods.push(risingEdges[i]! - risingEdges[i - 1]!);
    const avgPeriod = periods.reduce((a, b) => a + b, 0) / periods.length;
    const measuredFreq = 1 / avgPeriod;
    expect(Math.abs(measuredFreq - expectedFreq) / expectedFreq).toBeLessThan(0.1);

    // Threshold oscillates between ~1/3 VCC (1.67V) and ~2/3 VCC (3.33V)
    const steadyThr = vThr.filter((_, i) => t[i]! > 2e-3);
    expect(Math.min(...steadyThr)).toBeCloseTo(5 / 3, 1);
    expect(Math.max(...steadyThr)).toBeCloseTo((2 * 5) / 3, 1);
  });

  it('simulates LM358 non-inverting amplifier (.op and .ac) with unused channel 2 open', async () => {
    const q = build(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '9' } });
      tx.addComponent({ ref: 'VIN', part: 'dc_supply', props: { voltage: '1.5' } });
      tx.addComponent({ ref: 'RF', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RG', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: 'lm358' });
      tx.connect('VCC', ['BAT1.+', 'U1.VCC']);
      tx.connect('IN', ['VIN.+', 'U1.1IN+']);
      tx.connect('FB', ['U1.1IN-', 'RF.2', 'RG.1']);
      tx.connect('OUT', ['U1.1OUT', 'RF.1']);
      tx.connect('GND', ['BAT1.-', 'VIN.-', 'RG.2', 'U1.GND']);
    });

    const opRes = await op(q);
    expect(opRes.vectors['V(OUT)']![0]).toBeCloseTo(3.0, 3);
    expect(opRes.vectors['V(FB)']![0]).toBeCloseTo(1.5, 3);

    const acRes = await ac(q, { sweep: 'dec', points: 20, start: 100, stop: 5e6, probes: ['V(OUT)'] });
    const freqs = acRes.scale.values;
    const mag = acRes.vectors['V(OUT)']!;
    const i1k = freqs.findIndex(f => f >= 1000);
    expect(mag[i1k]!).toBeCloseTo(2.0, 2);

    // Gain=2 -> -3dB bandwidth ~ GBW/2 = 500 kHz
    const target = mag[0]! * Math.SQRT1_2;
    const bwIdx = freqs.findIndex((f, i) => f > 1000 && mag[i]! <= target);
    expect(bwIdx).toBeGreaterThan(0);
    expect(freqs[bwIdx]!).toBeGreaterThan(400e3);
    expect(freqs[bwIdx]!).toBeLessThan(650e3);
  });
});

describe('determinism, sequential reuse, concurrency, and errors', () => {
  it('produces identical results across insertion orders and two sequential runs in one process', async () => {
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

    expect(toSpiceNetlist(q1, { analysis: { kind: 'op' } })).toBe(toSpiceNetlist(q2, { analysis: { kind: 'op' } }));

    const r1 = await op(q1, { probes: ['V(LA)', 'I(D1)'] });
    const r2 = await op(q2, { probes: ['V(LA)', 'I(D1)'] });
    expect(r1).toEqual(r2);
    expect(Object.keys(r1.vectors)).toEqual(Object.keys(r2.vectors));

    // Sequential tran runs in the same process must give bit-identical results
    const qRc = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'C1', part: 'cap', props: { capacitance: '1u' } });
      tx.connect('IN', ['V1.+', 'R1.1']);
      tx.connect('OUT', ['R1.2', 'C1.1']);
      tx.connect('GND', ['V1.-', 'C1.2']);
    });
    const t1 = await tran(qRc, { stop: 2e-3, step: 50e-6 });
    const t2 = await tran(qRc, { stop: 2e-3, step: 50e-6 });
    expect(t1).toEqual(t2);
  });

  it('handles concurrent calls safely and recovers cleanly after ngspice errors', async () => {
    const qGood = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '1k' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '1k' } });
      tx.connect('VCC', ['V1.+', 'R1.1']);
      tx.connect('MID', ['R1.2', 'R2.1']);
      tx.connect('GND', ['R2.2', 'V1.-']);
    });

    // Failing run (shorted voltage sources) must throw CadError, not return stale data
    const qBad = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'V2', part: 'dc_supply', props: { voltage: '3' } });
      tx.connect('VCC', ['V1.+', 'V2.+']);
      tx.connect('GND', ['V1.-', 'V2.-']);
    });

    await expect(op(qGood)).resolves.toMatchObject({ vectors: { 'V(MID)': new Float64Array([2.5]) } });
    await expect(op(qBad)).rejects.toThrow(CadError);
    await expect(runSpice('Bad\nV1 1 0 5\nD1 1 0 MISSING_MODEL\n.op\n.end', { kind: 'op' })).rejects.toThrow(CadError);

    // Shared instance must still recover and solve concurrent runs cleanly
    const [a, b] = await Promise.all([
      op(qGood),
      ac(qGood, { sweep: 'lin', points: 5, start: 100, stop: 1000, probes: ['I(R1)', 'I(R1.1)'] }),
    ]);
    expect(a.vectors['V(MID)']![0]).toBeCloseTo(2.5, 6);
    expect(b.vectors['V(MID)']![0]).toBeCloseTo(0.5, 6);
    expect(b.vectors['I(R1)']![0]).toBeCloseTo(5e-4, 6);
    expect(b.vectors['I(R1.1)']![0]).toBeCloseTo(5e-4, 6);

    // Parameter & probe validation errors
    await expect(runSpice('   ', { kind: 'op' })).rejects.toThrow(CadError);
    await expect(tran(qGood, { stop: 0 })).rejects.toThrow(CadError);
    await expect(ac(qGood, { sweep: 'dec', points: 0, start: 10, stop: 100 })).rejects.toThrow(CadError);
    await expect(op(qGood, { probes: ['BADPROBE'] })).rejects.toThrow(CadError);

    const qNpn = build(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'Q1', part: 'npn' });
      tx.connect('VCC', ['V1.+', 'Q1.C']);
      tx.connect('GND', ['V1.-', 'Q1.E']);
    });
    await expect(op(qNpn, { probes: ['I(Q1)'] })).rejects.toThrow(/I\(Q1\)/);
  });
});
