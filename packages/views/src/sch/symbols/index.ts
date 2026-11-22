// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef, Query } from '@cadllm/core';
import { resolveSchFamily } from '../nets.ts';
import type { PlacedSymbol, SchPlace } from '../types.ts';
import { buildBattery } from './battery.ts';
import { buildButton } from './button.ts';
import { buildBuzzer } from './buzzer.ts';
import { buildCapacitor } from './capacitor.ts';
import { buildCapacitorPol } from './capacitor_pol.ts';
import { buildDiode } from './diode.ts';
import { buildGnd } from './gnd.ts';
import { buildIc } from './ic.ts';
import { buildInductor } from './inductor.ts';
import { buildLed } from './led.ts';
import { buildNmos } from './nmos.ts';
import { buildNpn } from './npn.ts';
import { buildPnp } from './pnp.ts';
import { buildPot } from './pot.ts';
import { buildProbe } from './probe.ts';
import { buildResistor } from './resistor.ts';
import { buildSwitch } from './switch.ts';
import { buildVcc } from './vcc.ts';
import { buildVsource } from './vsource.ts';
import { buildZener } from './zener.ts';

type SymbolBuilder = (q: Query, comp: Component, part: PartDef, place: SchPlace) => PlacedSymbol;

const BUILDERS: Record<string, SymbolBuilder> = {
  resistor: buildResistor,
  capacitor: buildCapacitor,
  capacitor_pol: buildCapacitorPol,
  inductor: buildInductor,
  pot: buildPot,
  diode: buildDiode,
  zener: buildZener,
  led: buildLed,
  battery: buildBattery,
  vsource: buildVsource,
  switch: buildSwitch,
  button: buildButton,
  buzzer: buildBuzzer,
  probe: buildProbe,
  vcc: buildVcc,
  gnd: buildGnd,
  npn: buildNpn,
  pnp: buildPnp,
  nmos: buildNmos,
  ic: (q, c, p, pl) => buildIc(q, c, p, pl, 'ic'),
  board: (q, c, p, pl) => buildIc(q, c, p, pl, 'board'),
};

/** Build a placed schematic symbol for any component; unknown families fall back to an IC box. */
export function buildSymbol(q: Query, comp: Component, part: PartDef, place: SchPlace): PlacedSymbol {
  const family = resolveSchFamily(part);
  const builder = BUILDERS[family];
  return builder ? builder(q, comp, part, place) : buildIc(q, comp, part, place, family);
}
