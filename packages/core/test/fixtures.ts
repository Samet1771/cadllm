import type { PartDef, PartResolver } from '../src/index.ts';

const parts: PartDef[] = [
  {
    id: 'res', name: 'Resistor', summary: 'resistor', category: 'passive', refPrefix: 'R', valueProp: 'resistance',
    pins: [{ id: '1', name: '1', type: 'passive' }, { id: '2', name: '2', type: 'passive' }],
    props: { resistance: { type: 'number', unit: 'Ω', default: '1k' } },
  },
  {
    id: 'led', name: 'LED', summary: 'LED', category: 'opto', refPrefix: 'D', valueProp: 'color',
    pins: [{ id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' }, { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' }],
    props: { color: { type: 'enum', options: ['red', 'green', 'blue'], default: 'red' } },
  },
  {
    id: 'battery', name: 'Battery', summary: 'battery', category: 'power', refPrefix: 'BAT', valueProp: 'voltage',
    pins: [{ id: '1', name: '+', type: 'power_out' }, { id: '2', name: '-', type: 'power_out' }],
    props: { voltage: { type: 'number', unit: 'V', default: '9' } },
  },
  {
    id: 'inv', name: 'Inverter', summary: 'inverter', category: 'logic', refPrefix: 'U',
    pins: [{ id: '1', name: 'A', type: 'input' }, { id: '2', name: 'Y', type: 'output' }],
  },
];

export const lib: PartResolver = { get: id => parts.find(p => p.id === id) };
