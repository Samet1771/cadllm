// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { loadCircuit, parseCnl, saveCnl } from '../src/index.ts';

describe('integration with @cadllm/library', () => {
  it('loads examples/nand-led.cnl against built-in parts and resolves every pin', () => {
    const library = loadLibrary([builtinPartsDir]);
    const path = resolve(import.meta.dirname, '../../../examples/nand-led.cnl');
    const golden = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

    const doc = loadCircuit(golden, library);
    expect(doc.read.components().map(c => c.ref)).toEqual(['BAT1', 'D1', 'R1', 'R2', 'SW1', 'U1']);
    expect(doc.read.nets().map(n => n.name)).toEqual(['GND', 'IN', 'LA', 'VCC', 'Y']);

    for (const net of doc.read.nets()) {
      for (const label of doc.read.sortedPins(net)) {
        const resolved = doc.read.resolvePin(label);
        expect(net.pins).toContain(resolved.key);
      }
    }

    expect(saveCnl(doc)).toBe(golden);
    expect(parseCnl(saveCnl(doc)).tests).toHaveLength(2);
  });

  it('loads examples/led-pcb.cnl against built-in parts and round-trips verbatim', () => {
    const library = loadLibrary([builtinPartsDir]);
    const path = resolve(import.meta.dirname, '../../../examples/led-pcb.cnl');
    const golden = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

    const doc = loadCircuit(golden, library);
    expect(saveCnl(doc)).toBe(golden);
    expect(doc.read.circuit.pcb?.board?.outline).toEqual([[0, 0], [30, 0], [30, 20], [0, 20]]);
    expect(doc.read.requireComponent('R1').props.footprint).toBe('THT-axial');
    expect(doc.read.requireComponent('D1').props.footprint).toBe('LED_D5.0mm');
  });
});
