// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Doc, type PartDef } from '@cadllm/core';
import { builtinPartsDir, createLibrary, loadLibrary, summaryLine, validatePart } from '../src/index.ts';
import { buildParts, serializePart } from '../scripts/gen-parts.ts';

function walkJson(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(full));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

describe('built-in parts/', () => {
  const files = walkJson(builtinPartsDir);
  const lib = loadLibrary([builtinPartsDir]);

  it('every file in parts/ validates, has unique id matching filename, and matches gen-parts output', () => {
    expect(files.length).toBeGreaterThanOrEqual(33);
    const seenIds = new Set<string>();
    const generated = new Map(buildParts().map(p => [p.id, serializePart(p)]));

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const parsed = JSON.parse(text) as PartDef;
      expect(validatePart(parsed)).toEqual([]);
      expect(parsed.id).toBe(basename(file, '.json'));
      expect(seenIds.has(parsed.id)).toBe(false);
      seenIds.add(parsed.id);
      expect(text).toBe(generated.get(parsed.id));
    }
    expect(seenIds.size).toBe(generated.size);
  });

  it('honours Shared part contract spot checks', () => {
    const res = lib.get('res')!;
    expect(res.valueProp).toBe('resistance');
    expect(res.props?.resistance?.default).toBe('1k');
    expect(res.sim).toEqual([{ kind: 'spice', ref: 'R' }, { kind: 'logic', ref: 'pull' }]);

    const pot = lib.get('pot')!;
    expect(pot.pins.map(p => `${p.id}:${p.name}`)).toEqual(['1:1', '2:W', '3:3']);
    expect(pot.pins[1]?.aliases).toContain('wiper');
    expect(pot.props?.position?.default).toBe('0.5');

    const led = lib.get('led')!;
    expect(led.props?.color?.options).toEqual(['red', 'green', 'blue', 'yellow', 'white']);
    expect(led.props?.color?.default).toBe('red');
    expect(led.pins[0]?.aliases).toEqual(['anode', '+']);
    expect(led.pins[1]?.aliases).toEqual(['cathode', '-']);

    const hc02 = lib.get('74hc02')!;
    expect(hc02.pins.slice(0, 3).map(p => `${p.id}:${p.name}`)).toEqual(['1:1Y', '2:1A', '3:1B']);

    const hc161 = lib.get('74hc161')!;
    expect(hc161.pins.find(p => p.id === '11')?.name).toBe('Q3');
    expect(hc161.pins.find(p => p.id === '14')?.name).toBe('Q0');

    const hc595 = lib.get('74hc595')!;
    expect(hc595.pins.find(p => p.id === '15')?.type).toBe('tristate');
    expect(hc595.pins.find(p => p.id === '9')?.aliases).toContain("QH'");

    const ne555 = lib.get('ne555')!;
    expect(ne555.pins.find(p => p.id === '3')?.type).toBe('output');
    expect(ne555.pins.find(p => p.id === '7')?.type).toBe('open_collector');

    const lm358 = lib.get('lm358')!;
    expect(lm358.pins.find(p => p.id === '4')?.aliases).toContain('V-');
    expect(lm358.pins.find(p => p.id === '8')?.aliases).toContain('V+');
  });

  it('every part instantiates in a core Doc and every pin resolves by id and name', () => {
    for (const part of lib.all()) {
      const doc = new Doc(lib);
      doc.transact(tx => {
        const comp = tx.addComponent({ part: part.id });
        for (const p of part.pins) {
          expect(tx.resolvePin(`${comp.ref}.${p.id}`).pin.id).toBe(p.id);
          expect(tx.resolvePin(`${comp.ref}.${p.name}`).pin.id).toBe(p.id);
        }
      });
    }
  });
});

describe('Library search, summaryLine, override and validatePart', () => {
  const lib = loadLibrary([builtinPartsDir]);

  it('ranks search queries as expected', () => {
    expect(lib.search('nand 5v dip')[0]?.id).toBe('74hc00');
    expect(lib.search('led')[0]?.id).toBe('led');
    expect(lib.search('counter')[0]?.id).toBe('74hc161');
    expect(lib.search('resistor', 2).length).toBeLessThanOrEqual(2);
  });

  it('formats summaryLine compactly with two-space separation and no trailing spaces', () => {
    const line = lib.summaryLine(lib.get('74hc00')!);
    expect(line).toBe('74hc00  quad 2-input NAND gate  14p DIP-14/SOIC-14  sim:logic');
    expect(line.endsWith(' ')).toBe(false);
    expect(summaryLine(lib.get('buzzer')!)).toBe('buzzer  piezo/active buzzer  2p Buzzer_12mm');
  });

  it('createLibrary overrides earlier parts with same id and sorts by id', () => {
    const a = { ...lib.get('res')!, summary: 'old' };
    const b = { ...lib.get('res')!, summary: 'new' };
    const c = lib.get('cap')!;
    const custom = createLibrary([a, c, b]);
    expect(custom.all().map(p => p.id)).toEqual(['cap', 'res']);
    expect(custom.get('res')?.summary).toBe('new');
  });

  it('validatePart catches invalid definitions', () => {
    expect(validatePart(null)).toEqual(['part must be an object']);
    expect(validatePart({
      id: 'x',
      name: 'X',
      summary: 's',
      category: 'ic',
      refPrefix: 'U',
      pins: [
        { id: '1', name: 'A', type: 'input', aliases: ['B'] },
        { id: '2', name: 'B', type: 'output' },
      ],
      props: {
        r: { type: 'number', default: 'not_si' },
        mode: { type: 'enum', options: ['a'], default: 'z' },
      },
      valueProp: 'missing',
    }).length).toBeGreaterThanOrEqual(5);
  });

  it('every built-in part names a drawing family for both views', () => {
    const missing = lib.all().filter(p => !p.views?.sch || !p.views?.bb).map(p => p.id);
    expect(missing).toEqual([]);
  });
});
