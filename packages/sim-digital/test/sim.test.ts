// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Doc, type PartDef, type PartResolver } from '@cadllm/core';
import { describe, expect, it } from 'vitest';
import {
  clockStimulus,
  formatTransitions,
  formatTruthTable,
  registerLogicModel,
  simulate,
  truthTable,
  type Logic,
  type StimulusEvent,
} from '../src/index.ts';
import { lib, parts } from './fixtures.ts';

function buildTwoInputGateDoc(partId: string): Doc {
  const doc = new Doc(lib);
  doc.transact(tx => {
    tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
    tx.addComponent({ ref: 'SW1', part: 'button' });
    tx.addComponent({ ref: 'SW2', part: 'button' });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
    tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' } });
    tx.addComponent({ ref: 'U1', part: partId });
    tx.connect('VCC', ['BAT1.+', 'SW1.1', 'SW2.1', 'U1.VCC']);
    tx.connect('GND', ['BAT1.-', 'R1.2', 'R2.2', 'U1.GND']);
    tx.connect('A', ['SW1.2', 'R1.1', 'U1.1A']);
    tx.connect('B', ['SW2.2', 'R2.1', 'U1.1B']);
    tx.connect('Y', ['U1.1Y']);
  });
  return doc;
}

describe('combinational gates & FOUNDATION NAND+LED example', () => {
  it.each([
    ['74hc00', ['1', '1', '1', '0'] as Logic[]],
    ['74hc02', ['1', '0', '0', '0'] as Logic[]],
    ['74hc08', ['0', '0', '0', '1'] as Logic[]],
    ['74hc32', ['0', '1', '1', '1'] as Logic[]],
    ['74hc86', ['0', '1', '1', '0'] as Logic[]],
  ])('%s full truth table', (partId, expectedOut) => {
    const doc = buildTwoInputGateDoc(partId);
    const tt = truthTable(doc.read, ['SW1', 'SW2'], ['U1.1Y']);
    expect(tt.rows).toEqual([
      { in: ['0', '0'], out: [expectedOut[0]] },
      { in: ['0', '1'], out: [expectedOut[1]] },
      { in: ['1', '0'], out: [expectedOut[2]] },
      { in: ['1', '1'], out: [expectedOut[3]] },
    ]);
  });

  it('74hc04 inverter truth table', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW1', part: 'switch_spst' });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc04' });
      tx.connect('VCC', ['V1.+', 'SW1.1', 'U1.VCC']);
      tx.connect('GND', ['V1.-', 'R1.2', 'U1.GND']);
      tx.connect('A', ['SW1.2', 'R1.1', 'U1.1A']);
      tx.connect('Y', ['U1.1Y']);
    });
    const tt = truthTable(doc.read, ['SW1'], ['U1.1Y']);
    expect(tt.rows).toEqual([
      { in: ['0'], out: ['1'] },
      { in: ['1'], out: ['0'] },
    ]);
  });

  it('FOUNDATION §3.1 button -> NAND gate -> LED circuit (ignores LED, pull-down works)', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5V' } });
      tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '330' } });
      tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'SW1', part: 'button' });
      tx.addComponent({ ref: 'U1', part: '74hc00' });
      tx.connect('VCC', ['BAT1.+', 'U1.VCC', 'U1.1A', 'SW1.1']);
      tx.connect('IN', ['SW1.2', 'U1.1B', 'R2.1']);
      tx.connect('GND', ['BAT1.-', 'U1.GND', 'D1.K', 'R2.2']);
      tx.connect('Y', ['U1.1Y', 'R1.1']);
      tx.connect('LA', ['R1.2', 'D1.A']);
    });
    const tt = truthTable(doc.read, ['SW1'], ['U1.1Y', 'LA']);
    expect(tt.rows).toEqual([
      { in: ['0'], out: ['1', '1'] },
      { in: ['1'], out: ['0', '0'] },
    ]);
    expect(formatTruthTable(tt)).toBe('SW1 -> U1.1Y LA\n0   -> 1     1\n1   -> 0     0');
  });

  it('formatTruthTable matches compact aligned layout', () => {
    const doc = buildTwoInputGateDoc('74hc00');
    const tt = truthTable(doc.read, ['SW1', 'SW2'], ['U1.1Y']);
    expect(formatTruthTable(tt)).toBe([
      'SW1 SW2 -> U1.1Y',
      '0   0   -> 1',
      '0   1   -> 1',
      '1   0   -> 1',
      '1   1   -> 0',
    ].join('\n'));
  });
});

describe('4-state resolution, pull resistors, power, and contention', () => {
  it('resolves Z for floating nets, weak pull-up/down without chaining, and X on weak conflict', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'VCC1', part: 'vcc_symbol', props: { voltage: '3.3V' } });
      tx.addComponent({ ref: 'GND1', part: 'gnd_symbol' });
      tx.addComponent({ ref: 'R1', part: 'res' });
      tx.addComponent({ ref: 'R2', part: 'res' });
      tx.addComponent({ ref: 'R3', part: 'res' });
      tx.addComponent({ ref: 'R4', part: 'res' });
      tx.addComponent({ ref: 'C1', part: 'cap' });
      tx.addComponent({ ref: 'P1', part: 'logic_probe' });
      tx.connect('VCC', ['VCC1.VCC', 'R1.1', 'R3.1']);
      tx.connect('GND', ['GND1.GND', 'R4.1']);
      tx.connect('HOP1', ['R1.2', 'R2.1']);
      tx.connect('HOP2', ['R2.2', 'P1.IN']);
      tx.connect('CONFLICT', ['R3.2', 'R4.2']);
      tx.connect('FLOAT', ['C1.1']);
    });
    const trace = simulate(doc.read, { until: 100e-9 });
    expect(trace.final.VCC).toBe('1');
    expect(trace.final.GND).toBe('0');
    expect(trace.final.HOP1).toBe('1');
    expect(trace.final.HOP2).toBe('Z'); // no weak->weak propagation across R2
    expect(trace.final.CONFLICT).toBe('X');
    expect(trace.final.FLOAT).toBe('Z');
  });

  it('const threshold is 2V and equal strong drivers do not conflict', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '1.8V' } });
      tx.addComponent({ ref: 'V2', part: 'vcc_symbol', props: { voltage: '5V' } });
      tx.addComponent({ ref: 'V3', part: 'battery', props: { voltage: '5V' } });
      tx.connect('LOW_V', ['V1.+']);
      tx.connect('GND', ['V1.-', 'V3.-']);
      tx.connect('SHARED_VCC', ['V2.VCC', 'V3.+']);
    });
    const trace = simulate(doc.read, { until: 50e-9 });
    expect(trace.final.LOW_V).toBe('0');
    expect(trace.final.GND).toBe('0');
    expect(trace.final.SHARED_VCC).toBe('1');
  });

  it('produces X on contention when two outputs drive opposite values', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: '74hc04' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U1.1A']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'U1.2A']);
      tx.connect('SHORT', ['U1.1Y', 'U1.2Y']); // 0 vs 1
    });
    const trace = simulate(doc.read, { until: 100e-9 });
    expect(trace.settled).toBe(true);
    expect(trace.final.SHORT).toBe('X');
  });

  it('outputs X when VCC is unpowered or GND is missing, and obeys dominating X inputs', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: '74hc08' }); // unpowered (VCC floating)
      tx.addComponent({ ref: 'U2', part: '74hc08' }); // powered, one input 0, one floating (Z)
      tx.addComponent({ ref: 'U3', part: '74hc32' }); // powered, one input 1, one floating (Z)
      tx.connect('VCC', ['V1.+', 'U2.VCC', 'U3.VCC', 'U1.1A', 'U1.1B', 'U3.1A']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'U2.GND', 'U3.GND', 'U2.1A']);
      tx.connect('Y_UNPWR', ['U1.1Y']);
      tx.connect('Y_AND_DOM', ['U2.1Y']);
      tx.connect('Y_OR_DOM', ['U3.1Y']);
    });
    const trace = simulate(doc.read, { until: 100e-9 });
    expect(trace.final.Y_UNPWR).toBe('X');
    expect(trace.final.Y_AND_DOM).toBe('0');
    expect(trace.final.Y_OR_DOM).toBe('1');
  });
});

describe('74hc74 dual D flip-flop', () => {
  it('starts X, captures D only on rising CLK edge, and supports async PRE/CLR', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW_D', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_CLK', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_PRE', part: 'switch_spst', props: { state: 'closed' } });
      tx.addComponent({ ref: 'SW_CLR', part: 'switch_spst', props: { state: 'closed' } });
      tx.addComponent({ ref: 'RD', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RC', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RP', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RL', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc74' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'SW_D.1', 'SW_CLK.1', 'SW_PRE.1', 'SW_CLR.1']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'RD.2', 'RC.2', 'RP.2', 'RL.2']);
      tx.connect('D', ['SW_D.2', 'RD.1', 'U1.1D']);
      tx.connect('CLK', ['SW_CLK.2', 'RC.1', 'U1.1CLK']);
      tx.connect('PRE', ['SW_PRE.2', 'RP.1', 'U1.1PRE']);
      tx.connect('CLR', ['SW_CLR.2', 'RL.1', 'U1.1CLR']);
      tx.connect('Q', ['U1.1Q']);
      tx.connect('QN', ['U1.1QN']);
    });

    // Initially X before reset or clock
    const tInit = simulate(doc.read, { until: 50e-9 });
    expect(tInit.final.Q).toBe('X');
    expect(tInit.final.QN).toBe('X');

    const stimulus: StimulusEvent[] = [
      // t=50n: change D to 1 while CLK=0 -> Q must remain X (not clocked)
      { t: 50e-9, ref: 'SW_D', state: 'closed' },
      // t=100n: rising CLK -> captures D=1 => Q=1, QN=0
      { t: 100e-9, ref: 'SW_CLK', state: 'closed' },
      // t=150n: D changes to 0 while CLK=1 -> Q stays 1
      { t: 150e-9, ref: 'SW_D', state: 'open' },
      // t=200n: falling CLK -> Q stays 1
      { t: 200e-9, ref: 'SW_CLK', state: 'open' },
      // t=250n: rising CLK with D=0 -> Q=0, QN=1
      { t: 250e-9, ref: 'SW_CLK', state: 'closed' },
      // t=300n: async PRE=0 -> Q=1, QN=0
      { t: 300e-9, ref: 'SW_PRE', state: 'open' },
      // t=350n: both PRE=0 and CLR=0 -> Q=1, QN=1
      { t: 350e-9, ref: 'SW_CLR', state: 'open' },
      // t=400n: release PRE=1 while CLR=0 -> Q=0, QN=1 (wait: CLR=0 while PRE=1 => Q=0, QN=1)
      { t: 400e-9, ref: 'SW_PRE', state: 'closed' },
    ];

    // Check snapshots at each phase
    expect(simulate(doc.read, { until: 80e-9, stimulus }).final.Q).toBe('X');
    const afterRise1 = simulate(doc.read, { until: 180e-9, stimulus });
    expect(afterRise1.final.Q).toBe('1');
    expect(afterRise1.final.QN).toBe('0');
    const afterFall = simulate(doc.read, { until: 230e-9, stimulus });
    expect(afterFall.final.Q).toBe('1');
    const afterRise2 = simulate(doc.read, { until: 280e-9, stimulus });
    expect(afterRise2.final.Q).toBe('0');
    expect(afterRise2.final.QN).toBe('1');
    const afterPre = simulate(doc.read, { until: 330e-9, stimulus });
    expect(afterPre.final.Q).toBe('1');
    expect(afterPre.final.QN).toBe('0');
    const afterBothLow = simulate(doc.read, { until: 380e-9, stimulus });
    expect(afterBothLow.final.Q).toBe('1');
    expect(afterBothLow.final.QN).toBe('1');
  });
});

describe('74hc161 4-bit counter', () => {
  function buildCounterDoc(): Doc {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW_CLK', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_MR', part: 'switch_spst', props: { state: 'open' } });
      tx.addComponent({ ref: 'SW_PE', part: 'switch_spst', props: { state: 'closed' } });
      tx.addComponent({ ref: 'RC', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RM', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'RP', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc161' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U1.CEP', 'U1.CET', 'U1.D0', 'U1.D2', 'SW_CLK.1', 'SW_MR.1', 'SW_PE.1']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'U1.D1', 'U1.D3', 'RC.2', 'RM.2', 'RP.2']);
      tx.connect('CLK', ['SW_CLK.2', 'RC.1', 'U1.CP']);
      tx.connect('MR', ['SW_MR.2', 'RM.1', 'U1.MR']);
      tx.connect('PE', ['SW_PE.2', 'RP.1', 'U1.PE']);
      tx.connect('Q0', ['U1.Q0']);
      tx.connect('Q1', ['U1.Q1']);
      tx.connect('Q2', ['U1.Q2']);
      tx.connect('Q3', ['U1.Q3']);
      tx.connect('TC', ['U1.TC']);
    });
    return doc;
  }

  it('counts 0..15, asserts TC at 15, wraps to 0, and supports parallel load', () => {
    const doc = buildCounterDoc();
    const readCount = (f: Record<string, Logic>): number =>
      (f.Q0 === '1' ? 1 : 0) + (f.Q1 === '1' ? 2 : 0) + (f.Q2 === '1' ? 4 : 0) + (f.Q3 === '1' ? 8 : 0);

    // Release reset at 20n, then 16 clock pulses starting at 100n with 100n period
    const baseStim: StimulusEvent[] = [
      { t: 20e-9, ref: 'SW_MR', state: 'closed' },
      ...clockStimulus('SW_CLK', 100e-9, 17, 100e-9),
    ];

    // Check every count 0..15 and wrap back to 0
    expect(readCount(simulate(doc.read, { until: 50e-9, stimulus: baseStim }).final)).toBe(0);
    for (let k = 1; k <= 15; k++) {
      const tr = simulate(doc.read, { until: (100 * k + 30) * 1e-9, stimulus: baseStim });
      expect(readCount(tr.final)).toBe(k);
      expect(tr.final.TC).toBe(k === 15 ? '1' : '0');
    }
    const wrapped = simulate(doc.read, { until: 1630e-9, stimulus: baseStim });
    expect(readCount(wrapped.final)).toBe(0);
    expect(wrapped.final.TC).toBe('0');

    // Synchronous parallel load of D3..D0 = 0101 (5)
    const loadStim: StimulusEvent[] = [
      { t: 20e-9, ref: 'SW_MR', state: 'closed' },
      { t: 50e-9, ref: 'SW_PE', state: 'open' },
      { t: 100e-9, ref: 'SW_CLK', state: 'closed' },
    ];
    const loaded = simulate(doc.read, { until: 150e-9, stimulus: loadStim });
    expect(readCount(loaded.final)).toBe(5);
  });

  it('clears outputs to 0 during held MR reset and ignores clocks while MR=0', () => {
    const doc = buildCounterDoc();
    const stim: StimulusEvent[] = [
      // Start with MR=1 at t=0, load 5, then assert held MR=0 from 200n..500n while clocking
      { t: 0, ref: 'SW_MR', state: 'closed' },
      { t: 50e-9, ref: 'SW_PE', state: 'open' },
      { t: 100e-9, ref: 'SW_CLK', state: 'closed' },
      { t: 150e-9, ref: 'SW_CLK', state: 'open' },
      { t: 160e-9, ref: 'SW_PE', state: 'closed' },
      { t: 200e-9, ref: 'SW_MR', state: 'open' }, // assert async MR=0
      { t: 300e-9, ref: 'SW_CLK', state: 'closed' }, // clock while MR=0 must be ignored
      { t: 400e-9, ref: 'SW_CLK', state: 'open' },
      { t: 500e-9, ref: 'SW_MR', state: 'closed' }, // release MR=1
    ];
    const duringMr = simulate(doc.read, { until: 450e-9, stimulus: stim });
    expect(duringMr.final.Q0).toBe('0');
    expect(duringMr.final.Q1).toBe('0');
    expect(duringMr.final.Q2).toBe('0');
    expect(duringMr.final.Q3).toBe('0');
    expect(duringMr.final.TC).toBe('0');
    const afterRelease = simulate(doc.read, { until: 550e-9, stimulus: stim });
    expect(afterRelease.final.Q0).toBe('0');
    expect(afterRelease.final.Q2).toBe('0');
  });
});

describe('74hc595 8-bit shift register', () => {
  it('shifts bits on SHCP, exposes Q7S, latches on STCP, clears on MR, tristates on OE', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW_DS', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_SH', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_ST', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_MR', part: 'switch_spst', props: { state: 'open' } });
      tx.addComponent({ ref: 'SW_OE', part: 'switch_spst', props: { state: 'open' } });
      for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) tx.addComponent({ ref: r, part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc595' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'SW_DS.1', 'SW_SH.1', 'SW_ST.1', 'SW_MR.1', 'SW_OE.1']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'R1.2', 'R2.2', 'R3.2', 'R4.2', 'R5.2']);
      tx.connect('DS', ['SW_DS.2', 'R1.1', 'U1.DS']);
      tx.connect('SHCP', ['SW_SH.2', 'R2.1', 'U1.SHCP']);
      tx.connect('STCP', ['SW_ST.2', 'R3.1', 'U1.STCP']);
      tx.connect('MR', ['SW_MR.2', 'R4.1', 'U1.MR']);
      tx.connect('OE', ['SW_OE.2', 'R5.1', 'U1.OE']);
      for (let i = 0; i < 8; i++) tx.connect(`Q${i}`, [`U1.Q${i}`]);
      tx.connect('Q7S', ['U1.Q7S']);
    });

    // Clear shift reg at t=0..20n, then shift in 1, 0, 1, 1, 0, 0, 0, 1 (LSB first -> Q7..Q0 = 10110001 -> Q0=1, Q4=1, Q5=1, Q7=1)
    const bits = [1, 0, 1, 1, 0, 0, 0, 1];
    const stimulus: StimulusEvent[] = [
      { t: 20e-9, ref: 'SW_MR', state: 'closed' },
    ];
    let t = 100e-9;
    for (const b of bits) {
      stimulus.push({ t, ref: 'SW_DS', state: b ? 'closed' : 'open' });
      stimulus.push({ t: t + 20e-9, ref: 'SW_SH', state: 'closed' });
      stimulus.push({ t: t + 50e-9, ref: 'SW_SH', state: 'open' });
      t += 100e-9;
    }
    // Latch at t = 920n
    stimulus.push({ t: 920e-9, ref: 'SW_ST', state: 'closed' });
    stimulus.push({ t: 950e-9, ref: 'SW_ST', state: 'open' });

    const latched = simulate(doc.read, { until: 1e-6, stimulus });
    expect(latched.final.Q7S).toBe('1'); // first shifted bit reached stage 7
    expect([
      latched.final.Q0, latched.final.Q1, latched.final.Q2, latched.final.Q3,
      latched.final.Q4, latched.final.Q5, latched.final.Q6, latched.final.Q7,
    ]).toEqual(['1', '0', '0', '0', '1', '1', '0', '1']);

    // OE = 1 disables Q0..Q7 to Z while Q7S remains driven
    const tristated = simulate(doc.read, {
      until: 1.1e-6,
      stimulus: [...stimulus, { t: 1.02e-6, ref: 'SW_OE', state: 'closed' }],
    });
    expect(tristated.final.Q0).toBe('Z');
    expect(tristated.final.Q7).toBe('Z');
    expect(tristated.final.Q7S).toBe('1');
  });

  it('clears shift register during held MR=0 and ignores SHCP while MR=0', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW_MR', part: 'switch_spst', props: { state: 'closed' } });
      tx.addComponent({ ref: 'SW_SH', part: 'switch_spst' });
      tx.addComponent({ ref: 'SW_ST', part: 'switch_spst' });
      for (const r of ['R1', 'R2', 'R3']) tx.addComponent({ ref: r, part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc595' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U1.DS', 'SW_MR.1', 'SW_SH.1', 'SW_ST.1']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'U1.OE', 'R1.2', 'R2.2', 'R3.2']);
      tx.connect('MR', ['SW_MR.2', 'R1.1', 'U1.MR']);
      tx.connect('SHCP', ['SW_SH.2', 'R2.1', 'U1.SHCP']);
      tx.connect('STCP', ['SW_ST.2', 'R3.1', 'U1.STCP']);
      tx.connect('Q0', ['U1.Q0']);
      tx.connect('Q7S', ['U1.Q7S']);
    });

    // MR starts 1 (outputs X), then MR=0 held from 100n..400n while SHCP clocks DS=1 -> Q7S becomes 0 and STCP latches 0
    const stim: StimulusEvent[] = [
      { t: 100e-9, ref: 'SW_MR', state: 'open' },
      { t: 200e-9, ref: 'SW_SH', state: 'closed' },
      { t: 250e-9, ref: 'SW_SH', state: 'open' },
      { t: 300e-9, ref: 'SW_ST', state: 'closed' },
      { t: 350e-9, ref: 'SW_ST', state: 'open' },
      { t: 400e-9, ref: 'SW_MR', state: 'closed' },
    ];
    const duringMr = simulate(doc.read, { until: 380e-9, stimulus: stim });
    expect(duringMr.final.Q7S).toBe('0');
    expect(duringMr.final.Q0).toBe('0');
  });
});

describe('multi-gate packages, clean 0->1 edges, X pull isolation, and zero-delay loop', () => {
  it('supports upper gates (4th NAND, 6th NOT, 2nd DFF) and ignores X->1 clock edges', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: '74hc00' });
      tx.addComponent({ ref: 'U2', part: '74hc04' });
      tx.addComponent({ ref: 'U3', part: '74hc74' });
      tx.addComponent({ ref: 'R1', part: 'res' });
      tx.addComponent({ ref: 'R2', part: 'res' });
      tx.addComponent({ ref: 'SW_C', part: 'button' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U2.VCC', 'U3.VCC', 'U1.4A', 'U3.2PRE', 'U3.2CLR', 'U3.2D', 'SW_C.1']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'U2.GND', 'U3.GND', 'U1.4B', 'R2.2']);
      tx.connect('Y_NAND4', ['U1.4Y', 'U2.6A']);
      tx.connect('Y_NOT6', ['U2.6Y']);
      // Contention on X_SRC (strong 1 vs strong 0 -> X); R1 should NOT propagate X across
      tx.connect('X_SRC', ['U1.1Y', 'U1.2Y']); // floating 1A,1B & 2A,2B -> wait: drive 1A=1,1B=1 (Y=0) vs 2A=0,2B=0 (Y=1)
      tx.connect('X_ISOLATED', ['R1.2']);
      tx.connect('CLK2', ['SW_C.2', 'R2.1', 'U3.2CLK']);
      tx.connect('Q2', ['U3.2Q']);
    });
    doc.transact(tx => {
      tx.connect('VCC', ['U1.2A', 'U1.2B']); // 2Y = 0
      tx.connect('GND', ['U1.1A', 'U1.1B']); // 1Y = 1 -> X_SRC = X
      tx.connect('X_SRC', ['R1.1']);
    });
    // Press button with 'pressed' state at t=50n -> clocks 2nd DFF cleanly
    const trace = simulate(doc.read, {
      until: 100e-9,
      stimulus: [{ t: 50e-9, ref: 'SW_C', state: 'pressed' }],
    });
    expect(trace.final.Y_NAND4).toBe('1');
    expect(trace.final.Y_NOT6).toBe('0');
    expect(trace.final.X_SRC).toBe('X');
    expect(trace.final.X_ISOLATED).toBe('Z');
    expect(trace.final.Q2).toBe('1');

    // Verify X->1 does NOT clock 74hc74: tie 2CLK to X_SRC via switch? Simpler: clock driven by contending gate then released?
    // Even simpler: 1CLK starts floating (Z), then switch shorts 1CLK to VCC at t=50n (Z->1, not 0->1).
    const doc2 = new Doc(lib);
    doc2.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW', part: 'switch_spst' });
      tx.addComponent({ ref: 'U1', part: '74hc74' });
      tx.connect('VCC', ['V1.+', 'U1.VCC', 'U1.1PRE', 'U1.1CLR', 'U1.1D', 'SW.1']);
      tx.connect('GND', ['V1.-', 'U1.GND']);
      tx.connect('CLK', ['SW.2', 'U1.1CLK']);
      tx.connect('Q', ['U1.1Q']);
    });
    const noClockTrace = simulate(doc2.read, {
      until: 100e-9,
      stimulus: [{ t: 50e-9, ref: 'SW', state: 'closed' }],
    });
    expect(noClockTrace.final.Q).toBe('X'); // Z->1 is not a clean 0->1 edge
  });

  it('caps zero-delay oscillation within a single timestep', () => {
    const zeroDelayInv: PartDef = {
      ...parts.find(p => p.id === '74hc04')!,
      id: '74hc04_zd',
      props: { delay: { type: 'number', unit: 's', default: '0' } },
    };
    const resolver: PartResolver = { get: id => (id === '74hc04_zd' ? zeroDelayInv : lib.get(id)) };
    const doc = new Doc(resolver);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW1', part: 'switch_spst' });
      tx.addComponent({ ref: 'R1', part: 'res' });
      tx.addComponent({ ref: 'U1', part: '74hc04_zd', props: { delay: '0' } });
      tx.connect('VCC', ['V1.+', 'U1.VCC']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'R1.2']);
      tx.connect('N1', ['U1.1A', 'R1.1', 'SW1.2']);
      tx.connect('N2', ['U1.1Y', 'SW1.1']);
    });
    const trace = simulate(doc.read, {
      until: 1e-6,
      stimulus: [{ t: 10e-9, ref: 'SW1', state: 'closed' }],
    });
    expect(trace.settled).toBe(false);
    expect(trace.warnings.length).toBeGreaterThan(0);
  });
});

describe('determinism, oscillation detection, formatting, and plugin models', () => {
  it('produces identical deterministic Trace across repeated runs', () => {
    const doc = buildTwoInputGateDoc('74hc86');
    const stimulus = [
      ...clockStimulus('SW1', 100e-9, 3, 20e-9),
      ...clockStimulus('SW2', 150e-9, 2, 40e-9),
    ];
    const t1 = simulate(doc.read, { until: 500e-9, stimulus });
    const t2 = simulate(doc.read, { until: 500e-9, stimulus });
    expect(t1).toEqual(t2);
  });

  it('detects oscillation in a 3-inverter ring (74hc04) without hanging', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'SW1', part: 'switch_spst', props: { state: 'open' } });
      tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '10k' } });
      tx.addComponent({ ref: 'U1', part: '74hc04' });
      tx.connect('VCC', ['V1.+', 'U1.VCC']);
      tx.connect('GND', ['V1.-', 'U1.GND', 'R1.2']);
      // Break loop with SW1: initially N1=0 -> 1Y=1 -> 2Y=0 -> 3Y=1. At t=50n SW1 closes, completing the 3-inverter ring!
      tx.connect('N1', ['U1.1A', 'R1.1', 'SW1.2']);
      tx.connect('N2', ['U1.1Y', 'U1.2A']);
      tx.connect('N3', ['U1.2Y', 'U1.3A']);
      tx.connect('N4', ['U1.3Y', 'SW1.1']);
    });
    const trace = simulate(doc.read, {
      until: 1e-3,
      stimulus: [{ t: 50e-9, ref: 'SW1', state: 'closed' }],
    });
    expect(trace.settled).toBe(false);
    expect(trace.warnings.length).toBeGreaterThan(0);
    expect(trace.warnings[0]).toMatch(/oscillation|limit/i);
  });

  it('formatTransitions aligns columns, formats SI time, resolves pin probes, and caps rows', () => {
    const doc = buildTwoInputGateDoc('74hc00');
    const stimulus: StimulusEvent[] = [
      { t: 1e-6, ref: 'SW1', state: 'closed' },
      { t: 1.5e-6, ref: 'SW2', state: 'closed' },
    ];
    const trace = simulate(doc.read, { until: 2e-6, stimulus });
    const roundTripped = JSON.parse(JSON.stringify(trace)) as typeof trace;
    expect(formatTransitions(roundTripped, ['A', 'B', 'Y'])).toBe([
      't     A B Y',
      '0     0 0 Z',
      '10n   0 0 1',
      '1u    1 0 1',
      '1.5u  1 1 1',
      '1.51u 1 1 0',
    ].join('\n'));
    const formatted = formatTransitions(trace, ['A', 'B', 'U1.1Y'], doc.read);
    expect(formatted).toBe([
      't     A B U1.1Y',
      '0     0 0 Z',
      '10n   0 0 1',
      '1u    1 0 1',
      '1.5u  1 1 1',
      '1.51u 1 1 0',
    ].join('\n'));
    expect(() => formatTransitions(roundTripped, ['U1.1Y'])).toThrow(/without Query/);

    // Row cap at 200
    const many = clockStimulus('SW1', 100e-9, 150, 100e-9);
    const longTrace = simulate(doc.read, { until: 20e-6, stimulus: many });
    const capped = formatTransitions(longTrace, ['A', 'U1.1Y'], doc.read);
    expect(capped).toContain('… ');
    expect(capped).toContain(' more rows');
  });

  it('supports custom delay override, plugin registerLogicModel, and errors on unknown logic ref', () => {
    const customPart: PartDef = {
      id: 'buf_custom', name: 'Buffer', summary: 'buffer', category: 'logic', refPrefix: 'U',
      pins: [{ id: '1', name: 'A', type: 'input' }, { id: '2', name: 'Y', type: 'output' }],
      props: { delay: { type: 'number', unit: 's', default: '10n' } },
      sim: [{ kind: 'logic', ref: 'test_buf' }],
    };
    const unknownPart: PartDef = {
      id: 'bad_ic', name: 'Bad', summary: 'bad', category: 'logic', refPrefix: 'U',
      pins: [{ id: '1', name: 'A', type: 'input' }],
      sim: [{ kind: 'logic', ref: 'no_such_model' }],
    };
    const resolver: PartResolver = {
      get: id => (id === 'buf_custom' ? customPart : id === 'bad_ic' ? unknownPart : parts.find(p => p.id === id)),
    };

    registerLogicModel('test_buf', {
      delay: 10e-9,
      eval(ctx) { ctx.drive('Y', ctx.read('A')); },
    });

    const doc = new Doc(resolver);
    doc.transact(tx => {
      tx.addComponent({ ref: 'V1', part: 'dc_supply', props: { voltage: '5' } });
      tx.addComponent({ ref: 'U1', part: 'buf_custom', props: { delay: '25n' } });
      tx.connect('VCC', ['V1.+', 'U1.A']);
      tx.connect('GND', ['V1.-']);
      tx.connect('Y', ['U1.Y']);
    });
    const trace = simulate(doc.read, { until: 50e-9 });
    expect(trace.changes.find(c => c.net === 'Y')).toEqual({ t: 25e-9, net: 'Y', v: '1' });

    const badDoc = new Doc(resolver);
    badDoc.transact(tx => { tx.addComponent({ ref: 'U9', part: 'bad_ic' }); });
    expect(() => simulate(badDoc.read, { until: 10e-9 })).toThrow(/U9.*no_such_model/);
  });
});
