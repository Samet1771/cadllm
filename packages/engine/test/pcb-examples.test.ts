// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { resolve } from 'node:path';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/index.ts';

const repo = resolve(import.meta.dirname, '../../..');
const library = loadLibrary([builtinPartsDir]);

describe('M3 PCB examples (layout + route + check)', () => {
  it('routes examples/led-pcb.cnl with 0 errors and 0 warnings', () => {
    const e = new Engine({ library, root: repo });
    e.project({ op: 'open', path: 'examples/led-pcb.cnl' });
    expect(e.layout({ view: 'pcb', op: 'route' })).toMatch(/^ok rev=1 routed \d+ tracks, \d+ vias/);
    expect(e.check()).toBe('led-pcb rev=1 0 err 0 warn');
  });

  it('places and routes examples/nand-led.cnl with 0 errors', () => {
    const e = new Engine({ library, root: repo });
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(e.layout({ view: 'pcb' })).toMatch(/^ok rev=1 placed 6 in pcb:/);
    expect(e.layout({ view: 'pcb', op: 'route' })).toMatch(/^ok rev=2 routed \d+ tracks, \d+ vias/);
    const check = e.check();
    expect(check).toMatch(/^nand-led rev=2 0 err /);
  });
});
