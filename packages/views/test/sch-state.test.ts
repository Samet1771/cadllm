// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Resvg } from '@resvg/resvg-js';
import { Doc } from '@cadllm/core';
import { applyEdit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { schematic } from '../src/sch/index.ts';

const library = loadLibrary([builtinPartsDir]);

function buildPlacedDoc(cnl: string): Doc {
  const doc = new Doc(library);
  doc.transact(tx => applyEdit(tx, cnl));
  const res = schematic.autoPlace(doc.read);
  doc.transact(tx => {
    for (const [ref, pos] of Object.entries(res.place)) {
      tx.updateComponent(ref, { place: { sch: pos } });
    }
  });
  return doc;
}

describe('schematic RenderOptions.state', () => {
  const CIRCUIT = [
    'BAT1 battery 5',
    'SW1  button released',
    'R1   res 220',
    'D1   led green',
    'VCC: BAT1.+ SW1.1',
    'IN:  SW1.2 R1.1',
    'LA:  R1.2 D1.A',
    'GND: BAT1.- D1.K',
  ].join('\n');

  it('produces byte-identical output when state is omitted or empty', () => {
    const doc = buildPlacedDoc(CIRCUIT);
    const plain = schematic.render(doc.read);
    expect(schematic.render(doc.read, { state: {} })).toBe(plain);
    expect(schematic.render(doc.read, { state: { nets: {}, parts: {} } })).toBe(plain);
  });

  it('renders deterministic lit LED glow scaled by level and color', () => {
    const doc = buildPlacedDoc(CIRCUIT);
    const svgFull = schematic.render(doc.read, {
      state: { parts: { D1: { on: true, level: 1 } } },
    });
    const svgHalf = schematic.render(doc.read, {
      state: { parts: { d1: { level: 0.4 } } },
    });
    const svgOff = schematic.render(doc.read, {
      state: { parts: { D1: { on: false, level: 0 } } },
    });

    expect(svgFull).toBe(schematic.render(doc.read, { state: { parts: { D1: { on: true, level: 1 } } } }));
    expect(svgFull).toContain('id="sch-led-glow"');
    expect(svgFull).toContain('#40c057'); // green LED fill
    expect(svgFull).toContain('fill-opacity="0.75"');
    expect(svgHalf).toContain('fill-opacity="0.3"');
    expect(svgOff).not.toContain('sch-led-glow');
  });

  it('draws pressed and released buttons according to state', () => {
    const doc = buildPlacedDoc(CIRCUIT);
    const pressed = schematic.render(doc.read, {
      state: { parts: { SW1: { on: true } } },
    });
    const released = schematic.render(doc.read, {
      state: { parts: { SW1: { on: false } } },
    });

    expect(pressed).toContain('M -9 -2 L 9 -2');
    expect(released).toContain('M -9 -7 L 9 -7');
    expect(pressed).not.toBe(released);
  });

  it('colors nets by logic level and annotates numeric voltages', () => {
    const doc = buildPlacedDoc(CIRCUIT);
    const svg = schematic.render(doc.read, {
      state: {
        nets: {
          VCC: '1',
          GND: '0',
          IN: 'X',
          LA: 3.3,
        },
      },
    });

    expect(svg).toContain('data-net="VCC" class="st-1"');
    expect(svg).toContain('data-net="GND" class="st-0"');
    expect(svg).toContain('data-net="IN" class="st-x"');
    expect(svg).toContain('stroke-dasharray:4 3');
    expect(svg).toContain('data-net="LA" class="st-v0"');
    expect(svg).toContain('3.3V');
  });

  it('renders cleanly to PNG via @resvg/resvg-js', () => {
    const doc = buildPlacedDoc(CIRCUIT);
    const svg = schematic.render(doc.read, {
      state: {
        nets: { VCC: '1', IN: '1', LA: 2.15, GND: '0' },
        parts: { SW1: { on: true }, D1: { on: true, level: 0.9 } },
      },
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 640 }, background: 'white' }).render().asPng();
    expect(png.byteLength).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });
});
