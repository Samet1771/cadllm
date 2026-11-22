// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import type { PartDef } from '@cadllm/core';
import {
  buildPartResolver,
  parseFindOutput,
  parseRevFromText,
  stripReadHeader,
} from '../src/lib/parts.ts';

const RES: PartDef = {
  id: 'res',
  name: 'Resistor',
  summary: 'axial/SMD resistor',
  category: 'passive',
  refPrefix: 'R',
  pins: [
    { id: '1', name: '1', type: 'passive' },
    { id: '2', name: '2', type: 'passive' },
  ],
};

describe('parts helpers', () => {
  it('builds case-insensitive PartResolver merging library and state.parts', () => {
    const resolver = buildPartResolver([RES], {
      led: {
        id: 'led',
        name: 'LED',
        summary: 'diode',
        category: 'io',
        refPrefix: 'D',
        pins: [],
      },
    });
    expect(resolver.get('res')?.id).toBe('res');
    expect(resolver.get('RES')?.id).toBe('res');
    expect(resolver.get('led')?.refPrefix).toBe('D');
    expect(resolver.get('missing')).toBeUndefined();
  });

  it('parses find output lines and ignores empty/more footer', () => {
    const resolver = buildPartResolver([RES]);
    const text = [
      'res  axial/SMD resistor  2p 0805/THT-axial  sim:spice,logic',
      'led  light-emitting diode  2p LED_D5.0mm  sim:spice',
      '… more (limit=60)',
    ].join('\n');
    const hits = parseFindOutput(text, resolver);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      id: 'res',
      summary: 'axial/SMD resistor',
      pins: '2p 0805/THT-axial',
      sim: 'sim:spice,logic',
      part: RES,
    });
    expect(hits[1]?.part).toBeUndefined();
    expect(parseFindOutput('no parts match "xyz" · categories: io')).toEqual([]);
  });

  it('extracts rev and strips read header', () => {
    expect(parseRevFromText('ok rev=13 +R1')).toBe(13);
    expect(parseRevFromText('nothing to undo (untitled rev=4)')).toBe(4);
    expect(parseRevFromText('ok')).toBeUndefined();

    expect(stripReadHeader('untitled rev=3\nR1 res 330\n\nVCC: R1.1')).toBe('R1 res 330\n\nVCC: R1.1');
    expect(stripReadHeader('untitled rev=0 (empty)')).toBe('');
  });
});
