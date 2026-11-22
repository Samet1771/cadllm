// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { DIODE_1N4148, LED_MODELS, ZENER_BASE, type LedColor } from '@cadllm/sim-analog';

export const ledModelName = (color: LedColor): string => `DLED_${color}`;

export const zenerModelName = (vz: number): string =>
  `DZ_${String(vz).replace(/\./g, 'p').replace(/[^A-Za-z0-9_]/g, '_')}`;

/** Standard Fairchild/ON Semiconductor 2N3904 NPN BJT model (onsemi.com/pdf/datasheet/2n3904-d.pdf). */
const MODEL_Q2N3904 = [
  '* 2N3904 NPN BJT — Fairchild/ON Semiconductor Gummel-Poon SPICE parameters (datasheet: onsemi.com/pdf/datasheet/2n3904-d.pdf)',
  '.model Q2N3904 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)',
].join('\n');

/** Standard Fairchild/ON Semiconductor 2N3906 PNP BJT model (onsemi.com/pdf/datasheet/2n3906-d.pdf). */
const MODEL_Q2N3906 = [
  '* 2N3906 PNP BJT — Fairchild/ON Semiconductor Gummel-Poon SPICE parameters (datasheet: onsemi.com/pdf/datasheet/2n3906-d.pdf)',
  '.model Q2N3906 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)',
].join('\n');

/** 2N7000 Level-1 NMOS model calibrated to ON Semiconductor 2N7000 datasheet (Vto=2.1V, Rds(on)~2ohm @ Vgs=5V). */
const MODEL_M2N7000 = [
  '* 2N7000 N-MOSFET — Level-1 model calibrated to ON Semiconductor 2N7000 datasheet (onsemi.com/pdf/datasheet/2n7000-d.pdf)',
  '.model M2N7000 NMOS(Level=1 Vto=2.1 Kp=0.35 Lambda=0.02 Rd=0.5 Rs=0.5 Cbd=30p Cgdo=10p Cgso=30p)',
].join('\n');

/**
 * NE555 behavioral macro-model calibrated to TI NE555 datasheet (ti.com/product/NE555):
 * 5k-5k-5k divider (1/3 & 2/3 VCC), comparators, active-low RESET (<0.7V), SR latch, totem-pole OUT, open-collector DIS.
 */
const SUBCKT_NE555 = [
  '* NE555 Timer macro-model — 5k divider, comparators, SR latch, open-collector DIS (datasheet: ti.com/product/NE555)',
  '.subckt NE555 GND TRIG OUT RESET CTRL THR DIS VCC',
  'Rdiv1 VCC CTRL 5k',
  'Rdiv2 CTRL trig_ref 5k',
  'Rdiv3 trig_ref GND 5k',
  'Rtrig TRIG GND 100Meg',
  'Rthr THR GND 100Meg',
  'Rrst RESET VCC 100k',
  'Cctrl CTRL GND 1p',
  'Bs s 0 V = 0.5*(1 + tanh(500*(v(trig_ref,GND) - v(TRIG,GND))))',
  'Br r 0 V = 0.5*(1 + tanh(500*(v(THR,GND) - v(CTRL,GND))))',
  'Brstb rstb 0 V = 0.5*(1 + tanh(500*(v(RESET,GND) - 0.7)))',
  'Bhold hold 0 V = 0.5*(1 + tanh(20*(v(q) - 0.5)))',
  'Bdrv drv 0 V = v(rstb)*(v(s) + (1 - v(s))*(1 - v(r))*v(hold))',
  'Rq drv q 1k',
  'Cq q 0 200p IC=1',
  'Bout_int out_int GND V = 0.5*(1 + tanh(30*(v(q) - 0.5)))*max(0, v(VCC,GND) - 1.2)',
  'Rout out_int OUT 10',
  'Bdis DIS GND I = 0.5*(1 + tanh(30*(0.4 - v(q)))) * v(DIS,GND) / 5 + v(DIS,GND) / 100Meg',
  '.ends NE555',
].join('\n');

/**
 * LM358 dual op-amp macro-model calibrated to TI LM358 datasheet (ti.com/product/LM358):
 * single-supply input stage (finite Zin so unused unit B never floats), Aol=100dB, GBW=1MHz, swing VEE+20mV..VCC-1.5V.
 */
const SUBCKT_LM358 = [
  '* LM358 Dual Op-Amp macro-model — Aol=100dB, GBW=1MHz, single-supply swing (datasheet: ti.com/product/LM358)',
  '.subckt LM358_CH INP INN VCC VEE OUT',
  'Rin INP INN 10Meg',
  'Rbiasp INP VEE 100Meg',
  'Rbiasn INN VEE 100Meg',
  'G1 0 gain_n INP INN 100',
  'Rp gain_n 0 1k',
  'Cp gain_n 0 15.915u',
  'Bclamp out_int VEE V = 0.5*((v(gain_n) + 0.02 + sqrt((v(gain_n) - 0.02)^2 + 1e-4)) - (v(gain_n) - max(0.05, v(VCC,VEE) - 1.5) + sqrt((v(gain_n) - max(0.05, v(VCC,VEE) - 1.5))^2 + 1e-4))) - 0.01',
  'Rout out_int OUT 50',
  '.ends LM358_CH',
  '.subckt LM358 1OUT 1INM 1INP GND 2INP 2INM 2OUT VCC',
  'XCH1 1INP 1INM VCC GND 1OUT LM358_CH',
  'XCH2 2INP 2INM VCC GND 2OUT LM358_CH',
  '.ends LM358',
].join('\n');

const STATIC_MODELS: Record<string, string> = {
  D1N4148: `* 1N4148 diode — @cadllm/sim-analog DIODE_1N4148\n.model D1N4148 D(Is=${DIODE_1N4148.is} N=${DIODE_1N4148.n})`,
  Q2N3904: MODEL_Q2N3904,
  Q2N3906: MODEL_Q2N3906,
  M2N7000: MODEL_M2N7000,
  NE555: SUBCKT_NE555,
  LM358: SUBCKT_LM358,
};

/** Emit SPICE .model / .subckt declarations for a sorted set of model keys and zener voltages. */
export function emitModels(modelKeys: Iterable<string>, zeners: Map<string, number>): string[] {
  const out: string[] = [];
  for (const key of [...new Set(modelKeys)].sort()) {
    if (key in STATIC_MODELS) {
      out.push(STATIC_MODELS[key]!);
      continue;
    }
    if (key.startsWith('DLED_')) {
      const color = key.slice(5) as LedColor;
      const m = LED_MODELS[color];
      if (m) {
        out.push(`* ${color} LED — @cadllm/sim-analog LED_MODELS.${color}\n.model ${key} D(Is=${m.is} N=${m.n})`);
      }
      continue;
    }
    if (zeners.has(key)) {
      const vz = zeners.get(key)!;
      out.push(
        `* Zener (${vz}V) — @cadllm/sim-analog ZENER_BASE\n.model ${key} D(Is=${ZENER_BASE.is} N=${ZENER_BASE.n} BV=${vz} IBV=${ZENER_BASE.ibv} NBV=${ZENER_BASE.nbv})`,
      );
    }
  }
  return out;
}
