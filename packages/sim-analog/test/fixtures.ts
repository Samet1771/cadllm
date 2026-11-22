// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PartDef, PartResolver } from '@cadllm/core';

/** Local copy of the M0 Shared Part Contract (docs/M0-PLAN.md) for standalone sim-analog tests. */
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
    id: 'cap_pol', name: 'Polarized Capacitor', summary: 'electrolytic capacitor', category: 'passive', refPrefix: 'C', valueProp: 'capacitance',
    pins: [{ id: '1', name: '+', aliases: ['pos'], type: 'passive' }, { id: '2', name: '-', aliases: ['neg'], type: 'passive' }],
    props: { capacitance: { type: 'number', unit: 'F', default: '10u' } },
    sim: [{ kind: 'spice', ref: 'C' }],
  },
  {
    id: 'inductor', name: 'Inductor', summary: 'inductor', category: 'passive', refPrefix: 'L', valueProp: 'inductance',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { inductance: { type: 'number', unit: 'H', default: '10u' } },
    sim: [{ kind: 'spice', ref: 'L' }],
  },
  {
    id: 'pot', name: 'Potentiometer', summary: 'potentiometer', category: 'passive', refPrefix: 'RV', valueProp: 'resistance',
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
    id: 'led', name: 'LED', summary: 'LED', category: 'opto', refPrefix: 'D', valueProp: 'color',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    props: { color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red' } },
    sim: [{ kind: 'spice', ref: 'LED' }],
  },
  {
    id: 'diode', name: 'Diode', summary: '1N4148 signal diode', category: 'semiconductor', refPrefix: 'D',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    sim: [{ kind: 'spice', ref: 'D1N4148' }],
  },
  {
    id: 'zener', name: 'Zener Diode', summary: 'zener diode', category: 'semiconductor', refPrefix: 'D', valueProp: 'voltage',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '5.1' } },
    sim: [{ kind: 'spice', ref: 'DZ' }],
  },
  {
    id: 'battery', name: 'Battery', summary: 'DC battery', category: 'power', refPrefix: 'BAT', valueProp: 'voltage',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '9' } },
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'dc_supply', name: 'DC Supply', summary: 'bench DC supply', category: 'power', refPrefix: 'V', valueProp: 'voltage',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '5' } },
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'vcc_symbol', name: 'VCC Symbol', summary: 'VCC rail', category: 'power', refPrefix: 'VCC', valueProp: 'voltage',
    pins: [{ id: '1', name: 'VCC', type: 'power_out' }],
    props: { voltage: { type: 'number', unit: 'V', default: '5' } },
    sim: [{ kind: 'spice', ref: 'VSYM' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'gnd_symbol', name: 'GND Symbol', summary: 'ground reference', category: 'power', refPrefix: 'GND',
    pins: [{ id: '1', name: 'GND', type: 'power_out' }],
    sim: [{ kind: 'spice', ref: 'GND' }, { kind: 'logic', ref: 'const' }],
  },
  {
    id: 'switch_spst', name: 'SPST Switch', summary: 'SPST switch', category: 'switch', refPrefix: 'SW', valueProp: 'state',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { state: { type: 'enum', options: ['open', 'closed'], default: 'open' } },
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
  },
  {
    id: 'button', name: 'Push Button', summary: 'momentary button', category: 'switch', refPrefix: 'BTN', valueProp: 'state',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { state: { type: 'enum', options: ['released', 'pressed'], default: 'released' } },
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
  },
  {
    id: 'buzzer', name: 'Buzzer', summary: 'piezo buzzer', category: 'io', refPrefix: 'BZ',
    pins: [{ id: '1', name: '+', type: 'passive' }, { id: '2', name: '-', type: 'passive' }],
  },
  {
    id: 'logic_probe', name: 'Logic Probe', summary: 'digital signal probe', category: 'symbol', refPrefix: 'TP',
    pins: [{ id: '1', name: 'IN', type: 'input' }],
    sim: [{ kind: 'logic', ref: 'probe' }],
  },
  {
    id: 'npn', name: '2N3904 NPN', summary: 'NPN BJT', category: 'transistor', refPrefix: 'Q',
    pins: [{ id: '1', name: 'E', type: 'passive' }, { id: '2', name: 'B', type: 'passive' }, { id: '3', name: 'C', type: 'passive' }],
    sim: [{ kind: 'spice', ref: 'Q2N3904' }],
  },
  {
    id: 'pnp', name: '2N3906 PNP', summary: 'PNP BJT', category: 'transistor', refPrefix: 'Q',
    pins: [{ id: '1', name: 'E', type: 'passive' }, { id: '2', name: 'B', type: 'passive' }, { id: '3', name: 'C', type: 'passive' }],
    sim: [{ kind: 'spice', ref: 'Q2N3906' }],
  },
  {
    id: 'nmos', name: '2N7000 NMOS', summary: 'N-channel MOSFET', category: 'transistor', refPrefix: 'M',
    pins: [{ id: '1', name: 'S', type: 'passive' }, { id: '2', name: 'G', type: 'passive' }, { id: '3', name: 'D', type: 'passive' }],
    sim: [{ kind: 'spice', ref: 'M2N7000' }],
  },
  {
    id: '74hc00', name: '74HC00 Quad NAND', summary: 'quad 2-input NAND gate', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: '1A', type: 'input' }, { id: '2', name: '1B', type: 'input' }, { id: '3', name: '1Y', type: 'output' },
      { id: '4', name: '2A', type: 'input' }, { id: '5', name: '2B', type: 'input' }, { id: '6', name: '2Y', type: 'output' },
      { id: '7', name: 'GND', type: 'power_in' },
      { id: '8', name: '3Y', type: 'output' }, { id: '9', name: '3A', type: 'input' }, { id: '10', name: '3B', type: 'input' },
      { id: '11', name: '4Y', type: 'output' }, { id: '12', name: '4A', type: 'input' }, { id: '13', name: '4B', type: 'input' },
      { id: '14', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc00' }],
  },
  {
    id: '74hc595', name: '74HC595 Shift Register', summary: '8-bit shift register', category: 'logic', refPrefix: 'U',
    pins: [
      { id: '1', name: 'Q1', type: 'tristate' }, { id: '8', name: 'GND', type: 'power_in' },
      { id: '9', name: 'Q7S', type: 'output' }, { id: '14', name: 'DS', type: 'input' },
      { id: '15', name: 'Q0', type: 'tristate' }, { id: '16', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc595' }],
  },
  {
    id: 'breadboard_half', name: 'Half Breadboard', summary: 'breadboard', category: 'board', refPrefix: 'BB',
    pins: [{ id: 'A1', name: 'A1', type: 'passive' }],
  },
  {
    id: 'arduino_uno', name: 'Arduino Uno', summary: 'Arduino Uno', category: 'board', refPrefix: 'A',
    pins: [{ id: '5V', name: '5V', type: 'power_out' }, { id: 'GND1', name: 'GND', type: 'power_in' }],
  },
  {
    id: 'ne555', name: 'NE555 Timer', summary: '555 timer IC', category: 'ic', refPrefix: 'U',
    pins: [
      { id: '1', name: 'GND', type: 'power_in' }, { id: '2', name: 'TRIG', type: 'input' },
      { id: '3', name: 'OUT', type: 'output' }, { id: '4', name: 'RESET', type: 'input' },
      { id: '5', name: 'CTRL', aliases: ['CONT'], type: 'passive' }, { id: '6', name: 'THR', type: 'input' },
      { id: '7', name: 'DIS', type: 'open_collector' }, { id: '8', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'spice', ref: 'NE555' }],
  },
  {
    id: 'lm358', name: 'LM358 Op-Amp', summary: 'dual op-amp', category: 'ic', refPrefix: 'U',
    pins: [
      { id: '1', name: '1OUT', type: 'output' }, { id: '2', name: '1IN-', type: 'input' },
      { id: '3', name: '1IN+', type: 'input' }, { id: '4', name: 'GND', aliases: ['V-'], type: 'power_in' },
      { id: '5', name: '2IN+', type: 'input' }, { id: '6', name: '2IN-', type: 'input' },
      { id: '7', name: '2OUT', type: 'output' }, { id: '8', name: 'VCC', aliases: ['V+'], type: 'power_in' },
    ],
    sim: [{ kind: 'spice', ref: 'LM358' }],
  },
];

export const lib: PartResolver = { get: id => parts.find(p => p.id === id) };
