// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { parseSI, type Component, type PartDef } from '@cadllm/core';
import { and4, findPin, nand4, nor4, not4, or4, xor4 } from './logic.ts';
import type { Logic, LogicModel, ModelContext } from './types.ts';

export const DEFAULT_PROP_DELAY = 10e-9;

export const logicModels = new Map<string, LogicModel>();

export function registerLogicModel(ref: string, model: LogicModel): void {
  logicModels.set(ref, model);
}

function isPowered(ctx: ModelContext): boolean {
  return ctx.read('VCC') === '1' && ctx.read('GND') === '0';
}

function makeTwoInputGateIC(gates: number, op: (a: Logic, b: Logic) => Logic): LogicModel {
  return {
    delay: DEFAULT_PROP_DELAY,
    eval(ctx) {
      const ok = isPowered(ctx);
      for (let i = 1; i <= gates; i++) {
        ctx.drive(`${i}Y`, ok ? op(ctx.read(`${i}A`), ctx.read(`${i}B`)) : 'X');
      }
    },
  };
}

function makeInverterIC(gates: number): LogicModel {
  return {
    delay: DEFAULT_PROP_DELAY,
    eval(ctx) {
      const ok = isPowered(ctx);
      for (let i = 1; i <= gates; i++) {
        ctx.drive(`${i}Y`, ok ? not4(ctx.read(`${i}A`)) : 'X');
      }
    },
  };
}

interface DffHalfState {
  q: Logic;
  qn: Logic;
  prevClk: Logic;
}

const model74hc74: LogicModel = {
  delay: DEFAULT_PROP_DELAY,
  init: () => ({
    h1: { q: 'X', qn: 'X', prevClk: 'Z' } satisfies DffHalfState,
    h2: { q: 'X', qn: 'X', prevClk: 'Z' } satisfies DffHalfState,
  }),
  eval(ctx) {
    const ok = isPowered(ctx);
    for (const i of [1, 2] as const) {
      const st = ctx.state[`h${i}`] as DffHalfState;
      const clk = ctx.read(`${i}CLK`);
      if (!ok) {
        st.q = 'X';
        st.qn = 'X';
        st.prevClk = clk;
        ctx.drive(`${i}Q`, 'X');
        ctx.drive(`${i}QN`, 'X');
        continue;
      }
      const pre = ctx.read(`${i}PRE`);
      const clr = ctx.read(`${i}CLR`);
      if (pre === '0' && clr === '0') {
        st.q = '1';
        st.qn = '1';
      } else if (pre === '0') {
        st.q = '1';
        st.qn = clr === '1' ? '0' : 'X';
      } else if (clr === '0') {
        st.q = pre === '1' ? '0' : 'X';
        st.qn = '1';
      } else if (pre !== '1' || clr !== '1') {
        st.q = 'X';
        st.qn = 'X';
      } else if (st.prevClk === '0' && clk === '1') {
        const d = ctx.read(`${i}D`);
        if (d === '0' || d === '1') {
          st.q = d;
          st.qn = not4(d);
        } else {
          st.q = 'X';
          st.qn = 'X';
        }
      }
      st.prevClk = clk;
      ctx.drive(`${i}Q`, st.q);
      ctx.drive(`${i}QN`, st.qn);
    }
  },
};

interface Counter161State {
  q: [Logic, Logic, Logic, Logic];
  prevCp: Logic;
}

const allKnownBits = (bits: readonly Logic[]): boolean => bits.every(b => b === '0' || b === '1');

const model74hc161: LogicModel = {
  delay: DEFAULT_PROP_DELAY,
  init: () => ({ q: ['X', 'X', 'X', 'X'], prevCp: 'Z' } satisfies Counter161State),
  eval(ctx) {
    const st = ctx.state as unknown as Counter161State;
    const cp = ctx.read('CP');
    if (!isPowered(ctx)) {
      st.q = ['X', 'X', 'X', 'X'];
      st.prevCp = cp;
      for (let i = 0; i < 4; i++) ctx.drive(`Q${i}`, 'X');
      ctx.drive('TC', 'X');
      return;
    }

    const mr = ctx.read('MR');
    if (mr === '0') {
      st.q = ['0', '0', '0', '0'];
    } else if (mr !== '1') {
      st.q = ['X', 'X', 'X', 'X'];
    } else if (st.prevCp === '0' && cp === '1') {
      const pe = ctx.read('PE');
      if (pe === '0') {
        for (let i = 0; i < 4; i++) {
          const d = ctx.read(`D${i}`);
          st.q[i] = d === '0' || d === '1' ? d : 'X';
        }
      } else if (pe === '1') {
        const cep = ctx.read('CEP');
        const cet = ctx.read('CET');
        if (cep === '1' && cet === '1') {
          if (allKnownBits(st.q)) {
            let val = 0;
            for (let i = 0; i < 4; i++) if (st.q[i] === '1') val |= 1 << i;
            const next = (val + 1) & 0xf;
            for (let i = 0; i < 4; i++) st.q[i] = ((next >> i) & 1) === 1 ? '1' : '0';
          } else {
            st.q = ['X', 'X', 'X', 'X'];
          }
        } else if (cep !== '0' && cet !== '0') {
          st.q = ['X', 'X', 'X', 'X'];
        }
      } else {
        st.q = ['X', 'X', 'X', 'X'];
      }
    }

    st.prevCp = cp;
    for (let i = 0; i < 4; i++) ctx.drive(`Q${i}`, st.q[i]!);
    const cet = ctx.read('CET');
    const tc = and4(cet, and4(and4(st.q[0], st.q[1]), and4(st.q[2], st.q[3])));
    ctx.drive('TC', tc);
  },
};

interface Shift595State {
  shift: Logic[];
  latch: Logic[];
  prevShcp: Logic;
  prevStcp: Logic;
}

const makeUnknown8 = (): Logic[] => ['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];

const model74hc595: LogicModel = {
  delay: DEFAULT_PROP_DELAY,
  init: () => ({
    shift: makeUnknown8(),
    latch: makeUnknown8(),
    prevShcp: 'Z',
    prevStcp: 'Z',
  } satisfies Shift595State),
  eval(ctx) {
    const st = ctx.state as unknown as Shift595State;
    const shcp = ctx.read('SHCP');
    const stcp = ctx.read('STCP');
    if (!isPowered(ctx)) {
      st.shift = makeUnknown8();
      st.latch = makeUnknown8();
      st.prevShcp = shcp;
      st.prevStcp = stcp;
      for (let i = 0; i < 8; i++) ctx.drive(`Q${i}`, 'X');
      ctx.drive('Q7S', 'X');
      return;
    }

    const mr = ctx.read('MR');
    if (mr === '0') {
      st.shift = ['0', '0', '0', '0', '0', '0', '0', '0'];
    } else if (mr !== '1') {
      st.shift = makeUnknown8();
    }

    // STCP latches shift register prior to any simultaneous SHCP edge (per 74HC595 datasheet).
    if (st.prevStcp === '0' && stcp === '1') {
      st.latch = [...st.shift];
    }

    if (mr === '1' && st.prevShcp === '0' && shcp === '1') {
      const ds = ctx.read('DS');
      for (let i = 7; i >= 1; i--) st.shift[i] = st.shift[i - 1]!;
      st.shift[0] = ds === '0' || ds === '1' ? ds : 'X';
    }

    st.prevShcp = shcp;
    st.prevStcp = stcp;

    ctx.drive('Q7S', st.shift[7]!);
    const oe = ctx.read('OE');
    for (let i = 0; i < 8; i++) {
      const v: Logic = oe === '0' ? st.latch[i]! : oe === '1' ? 'Z' : 'X';
      ctx.drive(`Q${i}`, v);
    }
  },
};

/** Compute strong constant drives for battery, dc_supply, vcc_symbol, gnd_symbol. */
export function evalConstDrives(comp: Component, part: PartDef): { pinId: string; v: Logic }[] {
  const out: { pinId: string; v: Logic }[] = [];
  const voltage = comp.props.voltage !== undefined ? parseSI(comp.props.voltage) : undefined;
  const high: Logic = (voltage ?? 5) >= 2 ? '1' : '0';

  for (const pin of part.pins) {
    const n = pin.name.toLowerCase();
    if (n === '+' || n === 'vcc') out.push({ pinId: pin.id, v: high });
    else if (n === '-' || n === 'gnd') out.push({ pinId: pin.id, v: '0' });
  }
  // Verify at least one constant pin matched if part has standard names; helper for sanity.
  if (out.length === 0) findPin(part, comp.ref, part.pins[0]?.name ?? '+');
  return out;
}

registerLogicModel('const', { role: 'const' });
registerLogicModel('switch', { role: 'switch' });
registerLogicModel('pull', { role: 'pull' });
registerLogicModel('probe', { role: 'probe' });

registerLogicModel('74hc00', makeTwoInputGateIC(4, nand4));
registerLogicModel('74hc02', makeTwoInputGateIC(4, nor4));
registerLogicModel('74hc04', makeInverterIC(6));
registerLogicModel('74hc08', makeTwoInputGateIC(4, and4));
registerLogicModel('74hc32', makeTwoInputGateIC(4, or4));
registerLogicModel('74hc86', makeTwoInputGateIC(4, xor4));
registerLogicModel('74hc74', model74hc74);
registerLogicModel('74hc161', model74hc161);
registerLogicModel('74hc595', model74hc595);
