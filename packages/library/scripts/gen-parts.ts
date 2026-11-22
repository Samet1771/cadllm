// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PartDef, PinDef, PinType } from '@cadllm/core';

const pin = (id: string, name: string, type: PinType, aliases?: string[]): PinDef =>
  aliases?.length ? { id, name, aliases, type } : { id, name, type };

function quad2Pins(norLayout = false): PinDef[] {
  const g1 = norLayout ? ['1Y', '1A', '1B'] : ['1A', '1B', '1Y'];
  const g2 = norLayout ? ['2Y', '2A', '2B'] : ['2A', '2B', '2Y'];
  const g3 = norLayout ? ['3A', '3B', '3Y'] : ['3Y', '3A', '3B'];
  const g4 = norLayout ? ['4A', '4B', '4Y'] : ['4Y', '4A', '4B'];
  const names = [...g1, ...g2, 'GND', ...g3, ...g4, 'VCC'];
  return names.map((n, i) => {
    const type: PinType = n === 'GND' || n === 'VCC' ? 'power_in' : n.endsWith('Y') ? 'output' : 'input';
    return pin(String(i + 1), n, type);
  });
}

function hexInvPins(): PinDef[] {
  const names = ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'];
  return names.map((n, i) => {
    const type: PinType = n === 'GND' || n === 'VCC' ? 'power_in' : n.endsWith('Y') ? 'output' : 'input';
    return pin(String(i + 1), n, type);
  });
}

function breadboardPins(cols: number): PinDef[] {
  const pins: PinDef[] = [];
  for (const rail of ['T+', 'T-', 'B+', 'B-']) {
    for (let c = 1; c <= cols; c++) {
      const id = `${rail}${c}`;
      pins.push(pin(id, id, 'passive'));
    }
  }
  for (const row of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    for (let c = 1; c <= cols; c++) {
      const id = `${row}${c}`;
      pins.push(pin(id, id, 'passive'));
    }
  }
  return pins;
}

function arduinoUnoPins(): PinDef[] {
  const pins: PinDef[] = [];
  for (let d = 0; d <= 13; d++) {
    const aliases = d === 0 ? ['RX'] : d === 1 ? ['TX'] : undefined;
    pins.push(pin(`D${d}`, `D${d}`, 'bidir', aliases));
  }
  for (let a = 0; a <= 5; a++) pins.push(pin(`A${a}`, `A${a}`, 'bidir'));
  pins.push(
    pin('5V', '5V', 'power_out'),
    pin('3V3', '3V3', 'power_out'),
    pin('VIN', 'VIN', 'power_in'),
    pin('GND1', 'GND', 'power_in'),
    pin('GND2', 'GND2', 'power_in'),
    pin('GND3', 'GND3', 'power_in'),
    pin('RESET', 'RESET', 'input'),
    pin('AREF', 'AREF', 'passive'),
    pin('IOREF', 'IOREF', 'power_out'),
  );
  return pins;
}

const logicGate = (id: string, name: string, summary: string, datasheet: string, keywords: string[], norLayout = false): PartDef => ({
  id,
  name,
  summary,
  category: 'logic',
  refPrefix: 'U',
  pins: quad2Pins(norLayout),
  sim: [{ kind: 'logic', ref: id }],
  footprints: ['DIP-14', 'SOIC-14'],
  keywords: ['74hc', 'cmos', 'logic', '5v', 'dip', ...keywords],
  datasheet,
});

/** Drawing family per view (see @cadllm/views). Logic and IC parts default to sch:ic bb:dip. */
const VIEWS: Record<string, [sch: string, bb: string]> = {
  res: ['resistor', 'axial'], cap: ['capacitor', 'disc'], cap_pol: ['capacitor_pol', 'radial'], inductor: ['inductor', 'axial'],
  pot: ['pot', 'pot'], diode: ['diode', 'axial'], zener: ['zener', 'axial'], led: ['led', 'led'],
  battery: ['battery', 'battery'], dc_supply: ['vsource', 'supply'], switch_spst: ['switch', 'slide_switch'], button: ['button', 'button'],
  buzzer: ['buzzer', 'buzzer'], logic_probe: ['probe', 'probe'], vcc_symbol: ['vcc', 'none'], gnd_symbol: ['gnd', 'none'],
  npn: ['npn', 'to92'], pnp: ['pnp', 'to92'], nmos: ['nmos', 'to92'], arduino_uno: ['board', 'arduino_uno'],
  breadboard_half: ['none', 'breadboard'], breadboard_full: ['none', 'breadboard'],
};

function withViews(p: PartDef): PartDef {
  const v = VIEWS[p.id] ?? (p.category === 'logic' || p.category === 'ic' ? ['ic', 'dip'] : undefined);
  if (!v) throw new Error(`gen-parts: no views for ${p.id}`);
  return { ...p, views: { sch: v[0], bb: v[1] } };
}

export function buildParts(): PartDef[] {
  return buildPartList().map(withViews);
}

function buildPartList(): PartDef[] {
  return [
    // passive
    {
      id: 'res',
      name: 'Resistor',
      summary: 'axial/SMD resistor',
      category: 'passive',
      refPrefix: 'R',
      pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')],
      props: { resistance: { type: 'number', unit: 'Ω', default: '1k', description: 'Resistance' } },
      valueProp: 'resistance',
      sim: [{ kind: 'spice', ref: 'R' }, { kind: 'logic', ref: 'pull' }],
      footprints: ['0805', 'THT-axial'],
      keywords: ['resistor', 'ohm', 'pullup', 'pulldown'],
    },
    {
      id: 'cap',
      name: 'Capacitor',
      summary: 'non-polarized capacitor',
      category: 'passive',
      refPrefix: 'C',
      pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')],
      props: { capacitance: { type: 'number', unit: 'F', default: '100n', description: 'Capacitance' } },
      valueProp: 'capacitance',
      sim: [{ kind: 'spice', ref: 'C' }],
      footprints: ['0805', 'C_Disc_D5.0mm'],
      keywords: ['capacitor', 'ceramic', 'film', 'decoupling', 'bypass'],
    },
    {
      id: 'cap_pol',
      name: 'Polarized Capacitor',
      summary: 'electrolytic/tantalum polarized capacitor',
      category: 'passive',
      refPrefix: 'C',
      pins: [pin('1', '+', 'passive', ['pos']), pin('2', '-', 'passive', ['neg'])],
      props: { capacitance: { type: 'number', unit: 'F', default: '10u', description: 'Capacitance' } },
      valueProp: 'capacitance',
      sim: [{ kind: 'spice', ref: 'C' }],
      footprints: ['CP_Radial_D5.0mm_P2.00mm', 'CP_Radial_D8.0mm_P3.50mm'],
      keywords: ['capacitor', 'electrolytic', 'polarized', 'bulk'],
    },
    {
      id: 'inductor',
      name: 'Inductor',
      summary: 'wire-wound/SMD inductor',
      category: 'passive',
      refPrefix: 'L',
      pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')],
      props: { inductance: { type: 'number', unit: 'H', default: '10u', description: 'Inductance' } },
      valueProp: 'inductance',
      sim: [{ kind: 'spice', ref: 'L' }],
      footprints: ['0805', 'L_Axial_L5.3mm'],
      keywords: ['inductor', 'coil', 'choke', 'henry'],
    },
    {
      id: 'pot',
      name: 'Potentiometer',
      summary: '3-terminal variable resistor',
      category: 'passive',
      refPrefix: 'RV',
      pins: [pin('1', '1', 'passive'), pin('2', 'W', 'passive', ['wiper']), pin('3', '3', 'passive')],
      props: {
        resistance: { type: 'number', unit: 'Ω', default: '10k', description: 'Total resistance' },
        position: { type: 'number', default: '0.5', description: 'Wiper fraction 0..1 from pin 1 to 3' },
      },
      valueProp: 'resistance',
      sim: [{ kind: 'spice', ref: 'POT' }],
      footprints: ['Potentiometer_THT_9mm'],
      keywords: ['potentiometer', 'trimmer', 'variable', 'divider'],
    },
    {
      id: 'diode',
      name: '1N4148 Diode',
      summary: 'fast switching silicon diode (1N4148)',
      category: 'passive',
      refPrefix: 'D',
      pins: [pin('1', 'A', 'passive', ['anode', '+']), pin('2', 'K', 'passive', ['cathode', '-'])],
      sim: [{ kind: 'spice', ref: 'D1N4148' }],
      footprints: ['THT-axial', 'DO-35', 'SOD-123'],
      keywords: ['diode', '1n4148', 'rectifier', 'switching'],
      datasheet: 'https://www.onsemi.com/pdf/datasheet/1n914-d.pdf',
    },
    {
      id: 'zener',
      name: 'Zener Diode',
      summary: 'voltage-regulating Zener diode',
      category: 'passive',
      refPrefix: 'D',
      pins: [pin('1', 'A', 'passive', ['anode', '+']), pin('2', 'K', 'passive', ['cathode', '-'])],
      props: { voltage: { type: 'number', unit: 'V', default: '5.1', description: 'Zener breakdown voltage' } },
      valueProp: 'voltage',
      sim: [{ kind: 'spice', ref: 'DZ' }],
      footprints: ['THT-axial', 'DO-35', 'DO-41'],
      keywords: ['zener', 'diode', 'clamp', 'regulator', 'reference'],
      datasheet: 'https://www.onsemi.com/pdf/datasheet/1n4728a-d.pdf',
    },

    // source
    {
      id: 'battery',
      name: 'Battery',
      summary: 'DC battery power source',
      category: 'source',
      refPrefix: 'BAT',
      pins: [pin('1', '+', 'power_out', ['pos']), pin('2', '-', 'power_out', ['neg'])],
      props: { voltage: { type: 'number', unit: 'V', default: '9', description: 'Battery voltage' } },
      valueProp: 'voltage',
      sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
      footprints: ['BatteryHolder_9V', 'WireLeads'],
      keywords: ['battery', 'power', 'dc', 'source', 'cell'],
    },
    {
      id: 'dc_supply',
      name: 'DC Power Supply',
      summary: 'regulated DC voltage source',
      category: 'source',
      refPrefix: 'PS',
      pins: [pin('1', '+', 'power_out', ['pos']), pin('2', '-', 'power_out', ['neg'])],
      props: { voltage: { type: 'number', unit: 'V', default: '5', description: 'Supply voltage' } },
      valueProp: 'voltage',
      sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
      footprints: ['Header_1x02_P2.54mm'],
      keywords: ['power', 'supply', 'dc', 'voltage', 'source', 'bench'],
    },

    // io
    {
      id: 'led',
      name: 'LED',
      summary: 'light-emitting diode',
      category: 'io',
      refPrefix: 'D',
      pins: [pin('1', 'A', 'passive', ['anode', '+']), pin('2', 'K', 'passive', ['cathode', '-'])],
      props: {
        color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red', description: 'LED color' },
      },
      valueProp: 'color',
      sim: [{ kind: 'spice', ref: 'LED' }],
      footprints: ['LED_D5.0mm', 'LED_D3.0mm', '0805'],
      keywords: ['led', 'light', 'diode', 'indicator'],
    },
    {
      id: 'switch_spst',
      name: 'SPST Switch',
      summary: 'single-pole single-throw toggle switch',
      category: 'io',
      refPrefix: 'SW',
      pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')],
      props: {
        state: { type: 'enum', options: ['open', 'closed'], default: 'open', description: 'Switch state' },
      },
      valueProp: 'state',
      sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
      footprints: ['SW_SPST_THT'],
      keywords: ['switch', 'spst', 'toggle', 'slide'],
    },
    {
      id: 'button',
      name: 'Push Button',
      summary: 'momentary tactile push button',
      category: 'io',
      refPrefix: 'SW',
      pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')],
      props: {
        state: { type: 'enum', options: ['released', 'pressed'], default: 'released', description: 'Button state' },
      },
      valueProp: 'state',
      sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
      footprints: ['SW_PUSH_6mm'],
      keywords: ['button', 'tactile', 'momentary', 'switch', 'input'],
    },
    {
      id: 'buzzer',
      name: 'Buzzer',
      summary: 'piezo/active buzzer',
      category: 'io',
      refPrefix: 'BZ',
      pins: [pin('1', '+', 'passive'), pin('2', '-', 'passive')],
      footprints: ['Buzzer_12mm'],
      keywords: ['buzzer', 'piezo', 'sound', 'alarm', 'audio'],
    },

    // transistor
    {
      id: 'npn',
      name: '2N3904 NPN Transistor',
      summary: 'general-purpose NPN BJT (2N3904)',
      category: 'transistor',
      refPrefix: 'Q',
      pins: [
        pin('1', 'E', 'passive', ['emitter']),
        pin('2', 'B', 'passive', ['base']),
        pin('3', 'C', 'passive', ['collector']),
      ],
      sim: [{ kind: 'spice', ref: 'Q2N3904' }],
      footprints: ['TO-92', 'SOT-23'],
      keywords: ['npn', 'bjt', 'transistor', '2n3904', 'amplifier', 'switch'],
      datasheet: 'https://www.onsemi.com/pdf/datasheet/2n3904-d.pdf',
    },
    {
      id: 'pnp',
      name: '2N3906 PNP Transistor',
      summary: 'general-purpose PNP BJT (2N3906)',
      category: 'transistor',
      refPrefix: 'Q',
      pins: [
        pin('1', 'E', 'passive', ['emitter']),
        pin('2', 'B', 'passive', ['base']),
        pin('3', 'C', 'passive', ['collector']),
      ],
      sim: [{ kind: 'spice', ref: 'Q2N3906' }],
      footprints: ['TO-92', 'SOT-23'],
      keywords: ['pnp', 'bjt', 'transistor', '2n3906', 'amplifier', 'switch'],
      datasheet: 'https://www.onsemi.com/pdf/datasheet/2n3906-d.pdf',
    },
    {
      id: 'nmos',
      name: '2N7000 N-MOSFET',
      summary: 'N-channel enhancement MOSFET (2N7000)',
      category: 'transistor',
      refPrefix: 'Q',
      pins: [
        pin('1', 'S', 'passive', ['source']),
        pin('2', 'G', 'passive', ['gate']),
        pin('3', 'D', 'passive', ['drain']),
      ],
      sim: [{ kind: 'spice', ref: 'M2N7000' }],
      footprints: ['TO-92', 'SOT-23'],
      keywords: ['nmos', 'mosfet', 'fet', 'transistor', '2n7000', 'switch'],
      datasheet: 'https://www.onsemi.com/pdf/datasheet/2n7000-d.pdf',
    },

    // logic
    logicGate('74hc00', '74HC00 Quad NAND', 'quad 2-input NAND gate', 'https://www.ti.com/product/SN74HC00', ['nand']),
    logicGate('74hc02', '74HC02 Quad NOR', 'quad 2-input NOR gate', 'https://www.ti.com/product/SN74HC02', ['nor'], true),
    {
      id: '74hc04',
      name: '74HC04 Hex Inverter',
      summary: 'hex inverting buffer (NOT)',
      category: 'logic',
      refPrefix: 'U',
      pins: hexInvPins(),
      sim: [{ kind: 'logic', ref: '74hc04' }],
      footprints: ['DIP-14', 'SOIC-14'],
      keywords: ['74hc', 'cmos', 'logic', '5v', 'dip', 'inverter', 'not'],
      datasheet: 'https://www.ti.com/product/SN74HC04',
    },
    logicGate('74hc08', '74HC08 Quad AND', 'quad 2-input AND gate', 'https://www.ti.com/product/SN74HC08', ['and']),
    logicGate('74hc32', '74HC32 Quad OR', 'quad 2-input OR gate', 'https://www.ti.com/product/SN74HC32', ['or']),
    logicGate('74hc86', '74HC86 Quad XOR', 'quad 2-input XOR gate', 'https://www.ti.com/product/SN74HC86', ['xor']),
    {
      id: '74hc74',
      name: '74HC74 Dual D Flip-Flop',
      summary: 'dual D-type flip-flop with preset and clear',
      category: 'logic',
      refPrefix: 'U',
      pins: [
        pin('1', '1CLR', 'input'), pin('2', '1D', 'input'), pin('3', '1CLK', 'input'), pin('4', '1PRE', 'input'),
        pin('5', '1Q', 'output'), pin('6', '1QN', 'output'), pin('7', 'GND', 'power_in'),
        pin('8', '2QN', 'output'), pin('9', '2Q', 'output'), pin('10', '2PRE', 'input'), pin('11', '2CLK', 'input'),
        pin('12', '2D', 'input'), pin('13', '2CLR', 'input'), pin('14', 'VCC', 'power_in'),
      ],
      sim: [{ kind: 'logic', ref: '74hc74' }],
      footprints: ['DIP-14', 'SOIC-14'],
      keywords: ['74hc', 'cmos', 'logic', '5v', 'dip', 'flip-flop', 'dff', 'latch'],
      datasheet: 'https://www.ti.com/product/SN74HC74',
    },
    {
      id: '74hc161',
      name: '74HC161 4-Bit Binary Counter',
      summary: 'synchronous 4-bit presettable binary counter',
      category: 'logic',
      refPrefix: 'U',
      pins: [
        pin('1', 'MR', 'input', ['CLR']), pin('2', 'CP', 'input', ['CLK']),
        pin('3', 'D0', 'input', ['A']), pin('4', 'D1', 'input', ['B']),
        pin('5', 'D2', 'input', ['C']), pin('6', 'D3', 'input', ['D']),
        pin('7', 'CEP', 'input', ['ENP']), pin('8', 'GND', 'power_in'),
        pin('9', 'PE', 'input', ['LOAD']), pin('10', 'CET', 'input', ['ENT']),
        pin('11', 'Q3', 'output', ['QD']), pin('12', 'Q2', 'output', ['QC']),
        pin('13', 'Q1', 'output', ['QB']), pin('14', 'Q0', 'output', ['QA']),
        pin('15', 'TC', 'output', ['RCO']), pin('16', 'VCC', 'power_in'),
      ],
      sim: [{ kind: 'logic', ref: '74hc161' }],
      footprints: ['DIP-16', 'SOIC-16'],
      keywords: ['74hc', 'cmos', 'logic', '5v', 'dip', 'counter', 'binary', '4-bit'],
      datasheet: 'https://www.ti.com/product/SN74HC161',
    },
    {
      id: '74hc595',
      name: '74HC595 8-Bit Shift Register',
      summary: '8-bit serial-in parallel-out shift register (3-state)',
      category: 'logic',
      refPrefix: 'U',
      pins: [
        pin('1', 'Q1', 'tristate', ['QB']), pin('2', 'Q2', 'tristate', ['QC']),
        pin('3', 'Q3', 'tristate', ['QD']), pin('4', 'Q4', 'tristate', ['QE']),
        pin('5', 'Q5', 'tristate', ['QF']), pin('6', 'Q6', 'tristate', ['QG']),
        pin('7', 'Q7', 'tristate', ['QH']), pin('8', 'GND', 'power_in'),
        pin('9', 'Q7S', 'output', ["QH'"]), pin('10', 'MR', 'input', ['SRCLR']),
        pin('11', 'SHCP', 'input', ['SRCLK']), pin('12', 'STCP', 'input', ['RCLK']),
        pin('13', 'OE', 'input'), pin('14', 'DS', 'input', ['SER']),
        pin('15', 'Q0', 'tristate', ['QA']), pin('16', 'VCC', 'power_in'),
      ],
      sim: [{ kind: 'logic', ref: '74hc595' }],
      footprints: ['DIP-16', 'SOIC-16'],
      keywords: ['74hc', 'cmos', 'logic', '5v', 'dip', 'shift', 'register', 'sipo'],
      datasheet: 'https://www.ti.com/product/SN74HC595',
    },

    // ic
    {
      id: 'ne555',
      name: 'NE555 Timer',
      summary: 'precision timer / oscillator IC',
      category: 'ic',
      refPrefix: 'U',
      pins: [
        pin('1', 'GND', 'power_in'),
        pin('2', 'TRIG', 'input'),
        pin('3', 'OUT', 'output'),
        pin('4', 'RESET', 'input'),
        pin('5', 'CTRL', 'input', ['CONT']),
        pin('6', 'THR', 'input', ['THRES']),
        pin('7', 'DIS', 'open_collector', ['DISCH']),
        pin('8', 'VCC', 'power_in'),
      ],
      sim: [{ kind: 'spice', ref: 'NE555' }],
      footprints: ['DIP-8', 'SOIC-8'],
      keywords: ['555', 'ne555', 'timer', 'oscillator', 'pwm', 'astable', 'monostable'],
      datasheet: 'https://www.ti.com/product/NE555',
    },
    {
      id: 'lm358',
      name: 'LM358 Dual Op-Amp',
      summary: 'dual general-purpose operational amplifier',
      category: 'ic',
      refPrefix: 'U',
      pins: [
        pin('1', '1OUT', 'output'),
        pin('2', '1IN-', 'input'),
        pin('3', '1IN+', 'input'),
        pin('4', 'GND', 'power_in', ['V-']),
        pin('5', '2IN+', 'input'),
        pin('6', '2IN-', 'input'),
        pin('7', '2OUT', 'output'),
        pin('8', 'VCC', 'power_in', ['V+']),
      ],
      sim: [{ kind: 'spice', ref: 'LM358' }],
      footprints: ['DIP-8', 'SOIC-8'],
      keywords: ['lm358', 'opamp', 'op-amp', 'amplifier', 'comparator', 'analog'],
      datasheet: 'https://www.ti.com/product/LM358',
    },

    // symbol
    {
      id: 'gnd_symbol',
      name: 'Ground Symbol',
      summary: '0V ground reference symbol',
      category: 'symbol',
      refPrefix: 'GND',
      pins: [pin('1', 'GND', 'power_out')],
      sim: [{ kind: 'spice', ref: 'GND' }, { kind: 'logic', ref: 'const' }],
      keywords: ['ground', 'gnd', '0v', 'reference', 'power', 'symbol'],
    },
    {
      id: 'vcc_symbol',
      name: 'VCC Symbol',
      summary: 'positive supply rail symbol',
      category: 'symbol',
      refPrefix: 'VCC',
      pins: [pin('1', 'VCC', 'power_out')],
      props: { voltage: { type: 'number', unit: 'V', default: '5', description: 'Rail voltage' } },
      valueProp: 'voltage',
      sim: [{ kind: 'spice', ref: 'VSYM' }, { kind: 'logic', ref: 'const' }],
      keywords: ['vcc', 'vdd', 'power', 'rail', '5v', '3.3v', 'symbol'],
    },
    {
      id: 'logic_probe',
      name: 'Logic Probe',
      summary: 'digital signal probe',
      category: 'symbol',
      refPrefix: 'TP',
      pins: [pin('1', 'IN', 'input')],
      sim: [{ kind: 'logic', ref: 'probe' }],
      keywords: ['probe', 'test', 'logic', 'digital', 'monitor'],
    },

    // board
    {
      id: 'breadboard_half',
      name: 'Half-Size Breadboard',
      summary: '420-pin half breadboard (A-E, F-J cols 1-30; rails T+/T-/B+/B-1..30; 5-hole vertical strips)',
      category: 'board',
      refPrefix: 'BB',
      pins: breadboardPins(30),
      footprints: ['Breadboard_Half_400'],
      keywords: ['breadboard', 'half', '400', 'prototype', 'board'],
    },
    {
      id: 'breadboard_full',
      name: 'Full-Size Breadboard',
      summary: '882-pin full breadboard (A-E, F-J cols 1-63; rails T+/T-/B+/B-1..63; 5-hole vertical strips)',
      category: 'board',
      refPrefix: 'BB',
      pins: breadboardPins(63),
      footprints: ['Breadboard_Full_830'],
      keywords: ['breadboard', 'full', '830', 'prototype', 'board'],
    },
    {
      id: 'arduino_uno',
      name: 'Arduino Uno',
      summary: 'ATmega328P microcontroller board (header pins)',
      category: 'board',
      refPrefix: 'A',
      pins: arduinoUnoPins(),
      footprints: ['Arduino_Uno_R3'],
      keywords: ['arduino', 'uno', 'atmega328p', 'mcu', 'board', 'dev'],
    },
  ];
}

const KEY_ORDER: (keyof PartDef)[] = [
  'id', 'name', 'summary', 'category', 'refPrefix',
  'pins', 'props', 'valueProp', 'sim', 'footprints', 'views', 'keywords', 'datasheet',
];

export function serializePart(part: PartDef): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (part[k] !== undefined) ordered[k] = part[k];
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const partsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../parts');
  const parts = buildParts();
  for (const p of parts) {
    const dir = join(partsDir, p.category);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${p.id}.json`), serializePart(p), 'utf8');
  }
  console.log(`Generated ${parts.length} parts in ${partsDir}`);
}
