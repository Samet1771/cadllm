// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PartDef, PartResolver, PinDef } from '@cadllm/core';

const makeQuad2Gate = (id: string, name: string, summary: string, norStyle = false): PartDef => {
  const pins: PinDef[] = norStyle
    ? [
        { id: '1', name: '1Y', type: 'output' }, { id: '2', name: '1A', type: 'input' }, { id: '3', name: '1B', type: 'input' },
        { id: '4', name: '2Y', type: 'output' }, { id: '5', name: '2A', type: 'input' }, { id: '6', name: '2B', type: 'input' },
        { id: '7', name: 'GND', type: 'power_in' },
        { id: '8', name: '3A', type: 'input' }, { id: '9', name: '3B', type: 'input' }, { id: '10', name: '3Y', type: 'output' },
        { id: '11', name: '4A', type: 'input' }, { id: '12', name: '4B', type: 'input' }, { id: '13', name: '4Y', type: 'output' },
        { id: '14', name: 'VCC', type: 'power_in' },
      ]
    : [
        { id: '1', name: '1A', type: 'input' }, { id: '2', name: '1B', type: 'input' }, { id: '3', name: '1Y', type: 'output' },
        { id: '4', name: '2A', type: 'input' }, { id: '5', name: '2B', type: 'input' }, { id: '6', name: '2Y', type: 'output' },
        { id: '7', name: 'GND', type: 'power_in' },
        { id: '8', name: '3Y', type: 'output' }, { id: '9', name: '3A', type: 'input' }, { id: '10', name: '3B', type: 'input' },
        { id: '11', name: '4Y', type: 'output' }, { id: '12', name: '4A', type: 'input' }, { id: '13', name: '4B', type: 'input' },
        { id: '14', name: 'VCC', type: 'power_in' },
      ];
  return { id, name, summary, category: 'logic', refPrefix: 'U', pins, sim: [{ kind: 'logic', ref: id }] };
};

export const parts: PartDef[] = [
  {
    id: 'res', name: 'Resistor', summary: 'resistor', category: 'passive', refPrefix: 'R', valueProp: 'resistance',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { resistance: { type: 'number', unit: 'Ω', default: '1k' } },
    sim: [{ kind: 'spice', ref: 'R' }, { kind: 'logic', ref: 'pull' }],
  },
  {
    id: 'cap', name: 'Capacitor', summary: 'capacitor', category: 'passive', refPrefix: 'C', valueProp: 'capacitance',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { capacitance: { type: 'number', unit: 'F', default: '100n' } },
    sim: [{ kind: 'spice', ref: 'C' }],
  },
  {
    id: 'led', name: 'LED', summary: 'LED', category: 'opto', refPrefix: 'D', valueProp: 'color',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    props: { color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red' } },
    sim: [{ kind: 'spice', ref: 'LED' }],
  },
  {
    id: 'battery', name: 'Battery', summary: 'battery', category: 'power', refPrefix: 'BAT', valueProp: 'voltage',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '9' } },
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'dc_supply', name: 'DC Supply', summary: 'DC power supply', category: 'power', refPrefix: 'V', valueProp: 'voltage',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '5' } },
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'vcc_symbol', name: 'VCC', summary: 'VCC symbol', category: 'power', refPrefix: 'VCC', valueProp: 'voltage',
    pins: [{ id: '1', name: 'VCC', type: 'power_out' }],
    props: { voltage: { type: 'number', unit: 'V', default: '5' } },
    sim: [{ kind: 'spice', ref: 'VSYM' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'gnd_symbol', name: 'GND', summary: 'GND symbol', category: 'power', refPrefix: 'GND',
    pins: [{ id: '1', name: 'GND', type: 'power_out' }],
    sim: [{ kind: 'spice', ref: 'GND' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'switch_spst', name: 'SPST Switch', summary: 'SPST switch', category: 'input', refPrefix: 'SW', valueProp: 'state',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { state: { type: 'enum', options: ['open', 'closed'], default: 'open' } },
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
  },
  {
    id: 'button', name: 'Push Button', summary: 'momentary button', category: 'input', refPrefix: 'SW', valueProp: 'state',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { state: { type: 'enum', options: ['released', 'pressed'], default: 'released' } },
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
  },
  {
    id: 'logic_probe', name: 'Logic Probe', summary: 'logic probe', category: 'probe', refPrefix: 'P',
    pins: [{ id: '1', name: 'IN', type: 'input' }],
    sim: [{ kind: 'logic', ref: 'probe' }],
  },
  makeQuad2Gate('74hc00', '74HC00', 'quad 2-input NAND'),
  makeQuad2Gate('74hc02', '74HC02', 'quad 2-input NOR', true),
  {
    id: '74hc04', name: '74HC04', summary: 'hex inverter', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: '1A', type: 'input' }, { id: '2', name: '1Y', type: 'output' },
      { id: '3', name: '2A', type: 'input' }, { id: '4', name: '2Y', type: 'output' },
      { id: '5', name: '3A', type: 'input' }, { id: '6', name: '3Y', type: 'output' },
      { id: '7', name: 'GND', type: 'power_in' },
      { id: '8', name: '4Y', type: 'output' }, { id: '9', name: '4A', type: 'input' },
      { id: '10', name: '5Y', type: 'output' }, { id: '11', name: '5A', type: 'input' },
      { id: '12', name: '6Y', type: 'output' }, { id: '13', name: '6A', type: 'input' },
      { id: '14', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc04' }],
  },
  makeQuad2Gate('74hc08', '74HC08', 'quad 2-input AND'),
  makeQuad2Gate('74hc32', '74HC32', 'quad 2-input OR'),
  makeQuad2Gate('74hc86', '74HC86', 'quad 2-input XOR'),
  {
    id: '74hc74', name: '74HC74', summary: 'dual D flip-flop', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: '1CLR', type: 'input' }, { id: '2', name: '1D', type: 'input' },
      { id: '3', name: '1CLK', type: 'input' }, { id: '4', name: '1PRE', type: 'input' },
      { id: '5', name: '1Q', type: 'output' }, { id: '6', name: '1QN', type: 'output' },
      { id: '7', name: 'GND', type: 'power_in' },
      { id: '8', name: '2QN', type: 'output' }, { id: '9', name: '2Q', type: 'output' },
      { id: '10', name: '2PRE', type: 'input' }, { id: '11', name: '2CLK', type: 'input' },
      { id: '12', name: '2D', type: 'input' }, { id: '13', name: '2CLR', type: 'input' },
      { id: '14', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc74' }],
  },
  {
    id: '74hc161', name: '74HC161', summary: '4-bit binary counter', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: 'MR', aliases: ['CLR'], type: 'input' },
      { id: '2', name: 'CP', aliases: ['CLK'], type: 'input' },
      { id: '3', name: 'D0', aliases: ['A'], type: 'input' },
      { id: '4', name: 'D1', aliases: ['B'], type: 'input' },
      { id: '5', name: 'D2', aliases: ['C'], type: 'input' },
      { id: '6', name: 'D3', aliases: ['D'], type: 'input' },
      { id: '7', name: 'CEP', aliases: ['ENP'], type: 'input' },
      { id: '8', name: 'GND', type: 'power_in' },
      { id: '9', name: 'PE', aliases: ['LOAD'], type: 'input' },
      { id: '10', name: 'CET', aliases: ['ENT'], type: 'input' },
      { id: '11', name: 'Q3', aliases: ['QD'], type: 'output' },
      { id: '12', name: 'Q2', aliases: ['QC'], type: 'output' },
      { id: '13', name: 'Q1', aliases: ['QB'], type: 'output' },
      { id: '14', name: 'Q0', aliases: ['QA'], type: 'output' },
      { id: '15', name: 'TC', aliases: ['RCO'], type: 'output' },
      { id: '16', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc161' }],
  },
  {
    id: '74hc595', name: '74HC595', summary: '8-bit shift register', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: 'Q1', type: 'tristate' }, { id: '2', name: 'Q2', type: 'tristate' },
      { id: '3', name: 'Q3', type: 'tristate' }, { id: '4', name: 'Q4', type: 'tristate' },
      { id: '5', name: 'Q5', type: 'tristate' }, { id: '6', name: 'Q6', type: 'tristate' },
      { id: '7', name: 'Q7', type: 'tristate' }, { id: '8', name: 'GND', type: 'power_in' },
      { id: '9', name: 'Q7S', aliases: ["QH'"], type: 'output' },
      { id: '10', name: 'MR', aliases: ['SRCLR'], type: 'input' },
      { id: '11', name: 'SHCP', aliases: ['SRCLK'], type: 'input' },
      { id: '12', name: 'STCP', aliases: ['RCLK'], type: 'input' },
      { id: '13', name: 'OE', type: 'input' },
      { id: '14', name: 'DS', aliases: ['SER'], type: 'input' },
      { id: '15', name: 'Q0', type: 'tristate' },
      { id: '16', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc595' }],
  },
];

export const lib: PartResolver = { get: id => parts.find(p => p.id === id) };
