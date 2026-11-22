// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { Resvg } from '@resvg/resvg-js';
import { Doc } from '@cadllm/core';
import { applyEdit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { breadboard } from '../src/bb/index.ts';

const library = loadLibrary([builtinPartsDir]);

function buildBbDoc(cnl: string): Doc {
  const doc = new Doc(library);
  doc.transact(tx => applyEdit(tx, cnl));
  return doc;
}

describe('breadboard RenderOptions.state', () => {
  const CIRCUIT = [
    'BB1  breadboard_half',
    'BAT1 battery 5V @bb:-8,2',
    'SW1  button released @bb:E4',
    'R1   res 330 @bb:D10-D14',
    'D1   led red @bb:E14-E16',
    'VCC: BAT1.+ SW1.1',
    'IN:  SW1.2 R1.1',
    'LA:  R1.2 D1.A',
    'GND: BAT1.- D1.K',
  ].join('\n');

  it('produces byte-identical output when state is omitted or empty', () => {
    const doc = buildBbDoc(CIRCUIT);
    const plain = breadboard.render(doc.read);
    expect(breadboard.render(doc.read, { state: {} })).toBe(plain);
    expect(breadboard.render(doc.read, { state: { nets: {}, parts: {} } })).toBe(plain);
  });

  it('renders deterministic lit LED glow scaled by level', () => {
    const doc = buildBbDoc(CIRCUIT);
    const svgOn = breadboard.render(doc.read, {
      state: { parts: { D1: { on: true, level: 1 } } },
    });
    const svgDim = breadboard.render(doc.read, {
      state: { parts: { D1: { level: 0.3 } } },
    });
    const svgOff = breadboard.render(doc.read, {
      state: { parts: { D1: { on: false } } },
    });

    expect(svgOn).toBe(breadboard.render(doc.read, { state: { parts: { D1: { on: true, level: 1 } } } }));
    expect(svgOn).toContain('id="bb-led-glow"');
    expect(svgOn).toContain('fill-opacity="0.85"');
    expect(svgDim).toContain('fill-opacity="0.26"');
    expect(svgOff).not.toContain('bb-led-glow');
  });

  it('renders pressed buttons and colored nets including numeric voltage badges', () => {
    const doc = buildBbDoc(CIRCUIT);
    const svg = breadboard.render(doc.read, {
      state: {
        nets: { VCC: '1', GND: '0', IN: 'X', LA: 2.05 },
        parts: { SW1: { on: true }, D1: { on: true } },
      },
    });

    expect(svg).toContain('data-net="VCC" class="bb-net st-1"');
    expect(svg).toContain('data-net="GND" class="bb-net st-0"');
    expect(svg).toContain('data-net="IN" class="bb-net st-x"');
    expect(svg).toContain('stroke-dasharray:4 3');
    expect(svg).toContain('2.05V');
    expect(svg).toContain('fill="#7f1d1d"');
  });

  it('renders cleanly to PNG via @resvg/resvg-js', () => {
    const doc = buildBbDoc(CIRCUIT);
    const svg = breadboard.render(doc.read, {
      state: {
        nets: { VCC: '1', IN: '1', LA: 2.1, GND: '0' },
        parts: { SW1: { on: true }, D1: { on: true, level: 1 } },
      },
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 800 }, background: 'white' }).render().asPng();
    expect(png.byteLength).toBeGreaterThan(2000);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });
});
