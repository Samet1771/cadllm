// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PartDef, PartResolver } from '@cadllm/core';

/** Local test fixtures following docs/M0-PLAN.md "Shared part contract". */
export const parts: PartDef[] = [
  {
    id: 'res',
    name: 'Resistor',
    summary: 'resistor',
    category: 'passive',
    refPrefix: 'R',
    valueProp: 'resistance',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: {
      resistance: { type: 'number', unit: 'Ω', default: '1k' },
      note: { type: 'string' },
    },
    sim: [{ kind: 'spice', ref: 'R' }, { kind: 'logic', ref: 'pull' }],
  },
  {
    id: 'cap',
    name: 'Capacitor',
    summary: 'non-polarized capacitor',
    category: 'passive',
    refPrefix: 'C',
    valueProp: 'capacitance',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: { capacitance: { type: 'number', unit: 'F', default: '100n' } },
    sim: [{ kind: 'spice', ref: 'C' }],
  },
  {
    id: 'pot',
    name: 'Potentiometer',
    summary: '3-terminal potentiometer',
    category: 'passive',
    refPrefix: 'RV',
    valueProp: 'resistance',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: 'W', aliases: ['wiper'], type: 'passive' },
      { id: '3', name: '3', type: 'passive' },
    ],
    props: {
      resistance: { type: 'number', unit: 'Ω', default: '10k' },
      position: { type: 'number', default: '0.5' },
    },
    sim: [{ kind: 'spice', ref: 'POT' }],
  },
  {
    id: 'led',
    name: 'LED',
    summary: 'light-emitting diode',
    category: 'opto',
    refPrefix: 'D',
    valueProp: 'color',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    props: {
      color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red' },
    },
    sim: [{ kind: 'spice', ref: 'LED' }],
  },
  {
    id: 'battery',
    name: 'Battery',
    summary: 'DC battery',
    category: 'power',
    refPrefix: 'BAT',
    valueProp: 'voltage',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '9' } },
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'button',
    name: 'Pushbutton',
    summary: 'momentary pushbutton',
    category: 'input',
    refPrefix: 'SW',
    valueProp: 'state',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: {
      state: { type: 'enum', options: ['released', 'pressed'], default: 'released' },
    },
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
  },
  {
    id: '74hc00',
    name: '74HC00',
    summary: 'quad 2-input NAND',
    category: 'logic',
    refPrefix: 'U',
    pins: [
      { id: '1', name: '1A', type: 'input' },
      { id: '2', name: '1B', type: 'input' },
      { id: '3', name: '1Y', type: 'output' },
      { id: '4', name: '2A', type: 'input' },
      { id: '5', name: '2B', type: 'input' },
      { id: '6', name: '2Y', type: 'output' },
      { id: '7', name: 'GND', type: 'power_in' },
      { id: '8', name: '3Y', type: 'output' },
      { id: '9', name: '3A', type: 'input' },
      { id: '10', name: '3B', type: 'input' },
      { id: '11', name: '4Y', type: 'output' },
      { id: '12', name: '4A', type: 'input' },
      { id: '13', name: '4B', type: 'input' },
      { id: '14', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc00' }],
  },
];

export const lib: PartResolver = {
  get: id => parts.find(p => p.id === id),
};
