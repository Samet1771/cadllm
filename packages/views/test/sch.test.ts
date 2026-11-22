// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Doc, type PartDef, type PartResolver } from '@cadllm/core';
import { applyEdit, loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { UNIT } from '../src/types.ts';
import { buildSymbol, parseSchPlace, schematic } from '../src/sch/index.ts';

const library = loadLibrary([builtinPartsDir]);

function buildDoc(cnl: string, parts: PartResolver = library): Doc {
  const doc = new Doc(parts);
  doc.transact(tx => { applyEdit(tx, cnl); });
  return doc;
}

function applyAutoPlace(doc: Doc): void {
  const res = schematic.autoPlace(doc.read);
  doc.transact(tx => {
    for (const [ref, pos] of Object.entries(res.place)) {
      tx.updateComponent(ref, { place: { sch: pos } });
    }
  });
}

/** Extract all integer grid points covered by orthogonal wire paths (`class="wire"`). */
function wireGridPoints(svg: string): { x: number; y: number; net: string }[] {
  const out: { x: number; y: number; net: string }[] = [];
  const netRe = /<g data-net="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g;
  let nm: RegExpExecArray | null;
  while ((nm = netRe.exec(svg)) !== null) {
    const net = nm[1]!;
    const body = nm[2]!;
    const pathRe = /<path d="([^"]+)" class="wire"\/>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pathRe.exec(body)) !== null) {
      const tokens = pm[1]!.split(/\s+/);
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < tokens.length; ) {
        const cmd = tokens[i++]!;
        if (cmd === 'M') {
          cx = Number(tokens[i++]!) / UNIT;
          cy = Number(tokens[i++]!) / UNIT;
        } else if (cmd === 'L') {
          const nx = Number(tokens[i++]!) / UNIT;
          const ny = Number(tokens[i++]!) / UNIT;
          const dx = Math.sign(nx - cx);
          const dy = Math.sign(ny - cy);
          let x = cx;
          let y = cy;
          out.push({ x, y, net });
          while (x !== nx || y !== ny) {
            x += dx;
            y += dy;
            out.push({ x, y, net });
          }
          cx = nx;
          cy = ny;
        }
      }
    }
  }
  return out;
}

describe('sch place parsing', () => {
  it('parses valid place strings and rejects invalid ones', () => {
    expect(parseSchPlace('12,4')).toEqual({ x: 12, y: 4, rot: 0, mirror: false });
    expect(parseSchPlace('12,4,90')).toEqual({ x: 12, y: 4, rot: 90, mirror: false });
    expect(parseSchPlace('30,10,0,m')).toEqual({ x: 30, y: 10, rot: 0, mirror: true });
    expect(parseSchPlace('-4,7,270,m')).toEqual({ x: -4, y: 7, rot: 270, mirror: true });
    expect(parseSchPlace('5,6,m')).toEqual({ x: 5, y: 6, rot: 0, mirror: true });

    for (const bad of ['', '12', '12.5,4', '12,4,45', '12,4,90,x', '12,4,m,90', 'E10', '1,2,3,4,5']) {
      expect(parseSchPlace(bad), bad).toBeUndefined();
    }
  });
});

describe('sch rotation and mirror pin positions', () => {
  it('rotates and mirrors 2-pin resistor pins accurately on integer grid', () => {
    const doc = buildDoc('R1 res 1k');
    const comp = doc.read.requireComponent('R1');
    const part = doc.read.part(comp);

    const p0 = buildSymbol(doc.read, comp, part, parseSchPlace('10,5')!);
    expect(p0.pins.map(p => [p.pin.id, p.gx, p.gy, p.dir])).toEqual([
      ['1', 8, 5, 'L'],
      ['2', 12, 5, 'R'],
    ]);

    const p90 = buildSymbol(doc.read, comp, part, parseSchPlace('10,5,90')!);
    expect(p90.pins.map(p => [p.pin.id, p.gx, p.gy, p.dir])).toEqual([
      ['1', 10, 3, 'U'],
      ['2', 10, 7, 'D'],
    ]);

    const p180 = buildSymbol(doc.read, comp, part, parseSchPlace('10,5,180')!);
    expect(p180.pins.map(p => [p.pin.id, p.gx, p.gy, p.dir])).toEqual([
      ['1', 12, 5, 'R'],
      ['2', 8, 5, 'L'],
    ]);

    const p270 = buildSymbol(doc.read, comp, part, parseSchPlace('10,5,270')!);
    expect(p270.pins.map(p => [p.pin.id, p.gx, p.gy, p.dir])).toEqual([
      ['1', 10, 7, 'D'],
      ['2', 10, 3, 'U'],
    ]);

    const pm = buildSymbol(doc.read, comp, part, parseSchPlace('10,5,0,m')!);
    expect(pm.pins.map(p => [p.pin.id, p.gx, p.gy, p.dir])).toEqual([
      ['1', 12, 5, 'R'],
      ['2', 8, 5, 'L'],
    ]);
  });

  it('rotates and mirrors asymmetric 3-pin npn transistor pins accurately', () => {
    const doc = buildDoc('Q1 npn');
    const comp = doc.read.requireComponent('Q1');
    const part = doc.read.part(comp);

    // Default rot=0: B at (-2,0), C at (1,-2), E at (1,2)
    const p0 = buildSymbol(doc.read, comp, part, parseSchPlace('10,10')!);
    expect(p0.pins.map(p => [p.pin.name, p.gx, p.gy, p.dir])).toEqual([
      ['B', 8, 10, 'L'],
      ['C', 11, 8, 'U'],
      ['E', 11, 12, 'D'],
    ]);

    // Mirror (0,m): B flips to (+2,0), C at (-1,-2), E at (-1,2)
    const pm = buildSymbol(doc.read, comp, part, parseSchPlace('10,10,0,m')!);
    expect(pm.pins.map(p => [p.pin.name, p.gx, p.gy, p.dir])).toEqual([
      ['B', 12, 10, 'R'],
      ['C', 9, 8, 'U'],
      ['E', 9, 12, 'D'],
    ]);

    // 90 deg clockwise: (-2,0)->(0,-2) U, (1,-2)->(2,1) R, (1,2)->(-2,1) L
    const p90 = buildSymbol(doc.read, comp, part, parseSchPlace('10,10,90')!);
    expect(p90.pins.map(p => [p.pin.name, p.gx, p.gy, p.dir])).toEqual([
      ['B', 10, 8, 'U'],
      ['C', 12, 11, 'R'],
      ['E', 8, 11, 'L'],
    ]);
  });

  it('keeps ref and value labels clear of pin stubs at all rotations for every symbol type', () => {
    const cnl = [
      'R1 res 1k',
      'C1 cap_pol 10u',
      'RV1 pot 10k',
      'D1 led red',
      'BAT1 battery 9V',
      'PS1 dc_supply 5V',
      'SW1 button',
      'BZ1 buzzer',
      'TP1 logic_probe',
      'Q1 npn',
      'U1 74hc00',
      'A1 arduino_uno',
    ].join('\n');
    const doc = buildDoc(cnl);

    for (const comp of doc.read.components()) {
      const part = doc.read.part(comp);
      for (const rot of [0, 90, 180, 270] as const) {
        const sym = buildSymbol(doc.read, comp, part, { x: 20, y: 20, rot, mirror: false });
        for (const lbl of sym.labels) {
          const w = lbl.text.length * 4.8;
          const lx1 = lbl.anchor === 'start' ? lbl.x : lbl.anchor === 'end' ? lbl.x - w : lbl.x - w / 2;
          const lx2 = lx1 + w;
          const ly1 = lbl.y - 7;
          const ly2 = lbl.y + 1;
          for (const pp of sym.pins) {
            const px = pp.gx * UNIT;
            const py = pp.gy * UNIT;
            const dx = pp.dir === 'L' ? 1 : pp.dir === 'R' ? -1 : 0;
            const dy = pp.dir === 'U' ? 1 : pp.dir === 'D' ? -1 : 0;
            const sx1 = Math.min(px, px + dx * 12);
            const sx2 = Math.max(px, px + dx * 12);
            const sy1 = Math.min(py, py + dy * 12);
            const sy2 = Math.max(py, py + dy * 12);
            const hits = lx1 <= sx2 && lx2 >= sx1 && ly1 <= sy2 && ly2 >= sy1;
            expect(hits, `${comp.ref} rot=${rot} label "${lbl.text}" hit pin ${pp.label}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('sch families, empty render, and check', () => {
  it('renders an empty message when nothing is placed', () => {
    const doc = buildDoc('R1 res 1k; D1 led red; BB1 breadboard_half');
    const svg = schematic.render(doc.read);
    expect(svg).toContain('data-view="sch"');
    expect(svg).toContain('no schematic placement — layout view=sch');
    expect(schematic.check(doc.read)).toEqual([
      { level: 'warn', code: 'unplaced', message: 'unplaced in schematic: D1, R1', at: ['D1', 'R1'] },
    ]);
  });

  it('detects bad_place and overlap without false positives', () => {
    const doc = buildDoc('R1 res 1k @sch:10,5\nR2 res 2k @sch:10,5\nR3 res 3k @sch:bad');
    const issues = schematic.check(doc.read);
    expect(issues).toEqual([
      { level: 'error', code: 'bad_place', message: 'R3: invalid schematic placement "bad" (expected x,y[,rot][,m])', at: ['R3'] },
      { level: 'warn', code: 'overlap', message: 'R1 and R2 overlap', at: ['R1', 'R2'] },
    ]);
  });

  it('renders every part family and falls back cleanly for unknown families', () => {
    const customPart: PartDef = {
      id: 'mystery_chip',
      name: 'Mystery',
      summary: 'unknown family test',
      category: 'misc',
      refPrefix: 'X',
      pins: [
        { id: '1', name: 'IN1', type: 'input' },
        { id: '2', name: 'OUT1', type: 'output' },
        { id: '3', name: 'VCC', type: 'power_in' },
      ],
      views: { sch: 'future_custom_family', bb: 'none' },
    };
    const resolver: PartResolver = {
      get: id => (id === 'mystery_chip' ? customPart : library.get(id)),
    };

    const cnl = [
      'R1 res 1k @sch:4,4',
      'C1 cap 100n @sch:10,4',
      'C2 cap_pol 10u @sch:16,4',
      'L1 inductor 10u @sch:22,4',
      'RV1 pot 10k @sch:28,4',
      'D1 diode @sch:4,10',
      'D2 zener 5.1 @sch:10,10',
      'D3 led green @sch:16,10',
      'BAT1 battery 9 @sch:22,10',
      'PS1 dc_supply 5 @sch:28,10',
      'SW1 switch_spst closed @sch:4,16',
      'SW2 button pressed @sch:10,16',
      'BZ1 buzzer @sch:16,16',
      'TP1 logic_probe @sch:22,16',
      'VCC1 vcc_symbol @sch:28,16',
      'GND1 gnd_symbol @sch:32,16',
      'Q1 npn @sch:4,22',
      'Q2 pnp @sch:10,22',
      'Q3 nmos @sch:16,22',
      'U1 74hc00 @sch:26,26',
      'A1 arduino_uno @sch:44,26',
      'X1 mystery_chip @sch:26,42',
      'BB1 breadboard_half',
    ].join('\n');

    const doc = buildDoc(cnl, resolver);
    const svg = schematic.render(doc.read);
    expect(svg).toContain('data-ref="X1"');
    expect(svg).toContain('IN1');
    expect(svg).toContain('OUT1');
    expect(svg).not.toContain('data-ref="BB1"');
    expect(schematic.check(doc.read).filter(i => i.code === 'bad_place' || i.code === 'unplaced')).toEqual([]);
  });
});

describe('sch routing, options, and determinism', () => {
  it('never routes wires through symbol bodies or pins of other nets', () => {
    const doc = buildDoc([
      'R1 res 1k @sch:10,10',
      'R2 res 1k @sch:10,14',
      'R3 res 1k @sch:10,18',
      'A: R1.1 R3.2',
      'B: R1.2 R2.1',
      'C: R2.2 R3.1',
    ].join('\n'));

    const svg = schematic.render(doc.read);
    const placedSymbols = doc.read.components().map(c =>
      buildSymbol(doc.read, c, doc.read.part(c), parseSchPlace(c.place['sch']!)!),
    );
    const blocked = new Set<string>();
    for (const s of placedSymbols) {
      for (const b of s.blockedCells) blocked.add(`${b.gx},${b.gy}`);
    }

    const pinNetByCoord = new Map<string, string>();
    for (const s of placedSymbols) {
      for (const p of s.pins) {
        const net = doc.read.netOfPin(p.key);
        pinNetByCoord.set(`${p.gx},${p.gy}`, net ? net.name : '__open__');
      }
    }

    const pts = wireGridPoints(svg);
    expect(pts.length).toBeGreaterThan(0);
    for (const pt of pts) {
      const k = `${pt.x},${pt.y}`;
      expect(blocked.has(k), `wire of ${pt.net} hit body at ${k}`).toBe(false);
      const owner = pinNetByCoord.get(k);
      if (owner !== undefined) {
        expect(owner, `wire of ${pt.net} hit pin of ${owner} at ${k}`).toBe(pt.net);
      }
    }
  });

  it('falls back to a dashed ratsnest line when completely blocked', () => {
    const doc = buildDoc([
      'TP1 logic_probe @sch:10,10',
      'R1 res 1k @sch:9,9',
      'R2 res 1k @sch:9,11',
      'R3 res 1k @sch:10,8,90',
      'R4 res 1k @sch:10,12,90',
      'R5 res 1k @sch:7,10,90',
      'R6 res 1k @sch:11,10,90',
      'TP2 logic_probe @sch:25,10',
      'SIG: TP1.IN TP2.IN',
    ].join('\n'));
    const svg = schematic.render(doc.read);
    expect(svg).toContain('class="ratsnest"');
  });

  it('honors highlight, select cropping, theme, labels, and is deterministic', () => {
    const doc = buildDoc([
      'BAT1 battery 5',
      'R1 res 220',
      'D1 led red',
      'VCC: BAT1.+ R1.1',
      'LA: R1.2 D1.A',
      'GND: D1.K BAT1.-',
    ].join('\n'));
    applyAutoPlace(doc);

    const svg1 = schematic.render(doc.read);
    const svg2 = schematic.render(doc.read);
    expect(svg1).toBe(svg2);

    const hlSvg = schematic.render(doc.read, { highlight: ['R1', 'net:LA'] });
    expect(hlSvg).toContain('<g data-ref="R1" class="hl">');
    expect(hlSvg).toContain('<g data-net="LA" class="hl">');
    expect(hlSvg).toContain('<g data-ref="D1">');

    const darkSvg = schematic.render(doc.read, { theme: 'dark' });
    expect(darkSvg).toContain('#0f172a');

    const noLabelSvg = schematic.render(doc.read, { labels: false });
    expect(noLabelSvg).not.toContain('class="lbl-ref"');

    const fullBoxMatch = svg1.match(/viewBox="([^"]+)"/)!;
    const cropSvg = schematic.render(doc.read, { select: ['R1'] });
    const cropBoxMatch = cropSvg.match(/viewBox="([^"]+)"/)!;
    const fullW = Number(fullBoxMatch[1]!.split(' ')[2]);
    const cropW = Number(cropBoxMatch[1]!.split(' ')[2]);
    expect(cropW).toBeLessThan(fullW);
  });

  it('respects already-placed components in autoPlace and handles feedback circuits', () => {
    const doc = buildDoc([
      'BAT1 battery 5',
      'U1 74hc74 @sch:25,0',
      'SW1 button',
      'R1 res 10k',
      'VCC: BAT1.+ U1.VCC U1.1PRE SW1.1',
      'GND: BAT1.- U1.GND R1.2',
      'CLK: SW1.2 R1.1 U1.1CLK',
      'Q0N: U1.1QN U1.1D',
    ].join('\n'));

    const res = schematic.autoPlace(doc.read);
    expect(res.place['U1']).toBeUndefined();
    expect(res.place['BAT1']).toBeDefined();
    expect(res.place['SW1']).toBeDefined();
    expect(res.place['R1']).toBeDefined();

    doc.transact(tx => {
      for (const [ref, pos] of Object.entries(res.place)) {
        tx.updateComponent(ref, { place: { sch: pos } });
      }
    });
    expect(schematic.check(doc.read)).toEqual([]);
    const svg = schematic.render(doc.read);
    expect(svg).toContain('data-net="Q0N"');
    expect(svg).toContain('data-net="CLK"');
  });
});

describe('sch golden SVGs', () => {
  it('matches golden SVG for LED circuit after autoPlace', () => {
    const doc = buildDoc([
      'BAT1 battery 5',
      'R1 res 220',
      'D1 led red',
      'VCC: BAT1.+ R1.1',
      'LA: R1.2 D1.A',
      'GND: D1.K BAT1.-',
    ].join('\n'));
    applyAutoPlace(doc);
    expect(schematic.check(doc.read)).toEqual([]);

    const svg = schematic.render(doc.read);
    expect(svg).toMatchInlineSnapshot(`"<svg xmlns="http://www.w3.org/2000/svg" viewBox="34 -67 309 131" width="309" height="131" data-view="sch"><style>.bg{fill:#ffffff}.sym{stroke:#1e293b;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.sym-fill{stroke:#1e293b;stroke-width:1.6;fill:#1e293b;stroke-linecap:round;stroke-linejoin:round}.ic-box{stroke:#1e293b;stroke-width:1.6;fill:#f8fafc;stroke-linejoin:round}.pin{fill:#64748b;stroke:none;opacity:0.45}.pin-hit{fill:transparent;stroke:none}.wire{stroke:#15803d;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.junc{fill:#15803d;stroke:none}.pwr-wire{stroke:#b91c1c;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.pwr-sym{stroke:#b91c1c;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.pwr-lbl{fill:#b91c1c;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:8px;font-weight:600}.gnd-wire{stroke:#334155;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.gnd-sym{stroke:#334155;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.gnd-lbl{fill:#334155;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:600}.ratsnest{stroke:#d97706;stroke-width:1.2;stroke-dasharray:4 3;fill:none}.lbl-ref{fill:#0f172a;font-family:'Segoe UI',Arial,'Liberation Sans',sans-serif;font-size:8.5px;font-weight:600}.lbl-val{fill:#475569;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:400}.pin-lbl{fill:#334155;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:500}.sym-mark{fill:#1e293b;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:600}.empty-msg{fill:#64748b;font-family:'Segoe UI',Arial,'Liberation Sans',sans-serif;font-size:11px;font-weight:500}.hl .sym,.hl .ic-box,.hl .wire,.hl .pwr-wire,.hl .pwr-sym,.hl .gnd-wire,.hl .gnd-sym,.hl .ratsnest{stroke:#2563eb;stroke-width:2.6}.hl .sym-fill,.hl .junc{fill:#2563eb;stroke:#2563eb}.hl .lbl-ref,.hl .lbl-val,.hl .pwr-lbl,.hl .gnd-lbl{fill:#2563eb}.hl .pin{fill:#2563eb;opacity:0.9}</style><rect x="34" y="-67" width="309" height="131" class="bg"/><g class="wires"><g data-net="GND"><path d="M 70 20 L 70 30" class="gnd-wire"/><path d="M 63 30 L 77 30 M 65.5 33.5 L 74.5 33.5 M 68 37 L 72 37" class="gnd-sym"/><path d="M 300 0 L 310 0 L 310 8" class="gnd-wire"/><path d="M 303 8 L 317 8 M 305.5 11.5 L 314.5 11.5 M 308 15 L 312 15" class="gnd-sym"/></g><g data-net="LA"><path d="M 200 0 L 260 0" class="wire"/></g><g data-net="VCC"><path d="M 70 -20 L 70 -30" class="pwr-wire"/><path d="M 64 -30 L 76 -30" class="pwr-sym"/><text x="70" y="-34" text-anchor="middle" class="pwr-lbl">VCC</text><path d="M 160 0 L 150 0" class="pwr-wire"/><path d="M 150 -5 L 150 5" class="pwr-sym"/><text x="146" y="2.5" text-anchor="end" class="pwr-lbl">VCC</text></g></g><g class="components"><g data-ref="BAT1"><g transform="translate(70,0)"><path d="M 0 -20 L 0 -6 M -10 -6 L 10 -6 M -5 -2 L 5 -2 M -10 2 L 10 2 M -5 6 L 5 6 M 0 6 L 0 20" class="sym"/></g><text x="62.5" y="-8.5" text-anchor="middle" class="sym-mark">+</text><text x="83" y="-2" text-anchor="start" class="lbl-ref">BAT1</text><text x="83" y="8" text-anchor="start" class="lbl-val">5</text><circle cx="70" cy="-20" r="1.6" class="pin" data-pin="BAT1.+"/><circle cx="70" cy="20" r="1.6" class="pin" data-pin="BAT1.-"/></g><g data-ref="D1"><g transform="translate(280,0)"><path d="M -20 0 L -6 0 M 6 0 L 20 0" class="sym"/><path d="M -6 -7 L 6 0 L -6 7 Z" class="sym"/><path d="M 6 -7 L 6 7" class="sym"/><path d="M -2 -9 L 4 -15 M 1.5 -15 L 4 -15 L 4 -12.5 M 3 -8 L 9 -14 M 6.5 -14 L 9 -14 L 9 -11.5" class="sym"/></g><text x="280" y="16" text-anchor="middle" class="lbl-ref">D1</text><text x="280" y="26" text-anchor="middle" class="lbl-val">red</text><circle cx="260" cy="0" r="1.6" class="pin" data-pin="D1.A"/><circle cx="300" cy="0" r="1.6" class="pin" data-pin="D1.K"/></g><g data-ref="R1"><g transform="translate(180,0)"><path d="M -20 0 L -12 0 L -10 -4.5 L -6 4.5 L -2 -4.5 L 2 4.5 L 6 -4.5 L 10 4.5 L 12 0 L 20 0" class="sym"/></g><text x="180" y="-8.5" text-anchor="middle" class="lbl-ref">R1</text><text x="180" y="14.5" text-anchor="middle" class="lbl-val">220</text><circle cx="160" cy="0" r="1.6" class="pin" data-pin="R1.1"/><circle cx="200" cy="0" r="1.6" class="pin" data-pin="R1.2"/></g></g></svg>"`);
  });

  it('places and routes examples/nand-led.cnl cleanly with zero issues and golden SVG', () => {
    const cnlPath = resolve(import.meta.dirname, '../../../examples/nand-led.cnl');
    const cnl = readFileSync(cnlPath, 'utf8');
    const doc = loadCircuit(cnl, library);

    applyAutoPlace(doc);
    expect(schematic.check(doc.read)).toEqual([]);

    const svg = schematic.render(doc.read);
    expect(svg).not.toContain('class="ratsnest"');

    // Verify no wire hits any symbol body in nand-led.cnl.
    const placedSymbols = doc.read.components().map(c =>
      buildSymbol(doc.read, c, doc.read.part(c), parseSchPlace(c.place['sch']!)!),
    );
    const blocked = new Set<string>();
    for (const s of placedSymbols) {
      for (const b of s.blockedCells) blocked.add(`${b.gx},${b.gy}`);
    }
    for (const pt of wireGridPoints(svg)) {
      expect(blocked.has(`${pt.x},${pt.y}`)).toBe(false);
    }

    expect(svg).toMatchInlineSnapshot(`"<svg xmlns="http://www.w3.org/2000/svg" viewBox="34 -147 609 291" width="609" height="291" data-view="sch"><style>.bg{fill:#ffffff}.sym{stroke:#1e293b;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.sym-fill{stroke:#1e293b;stroke-width:1.6;fill:#1e293b;stroke-linecap:round;stroke-linejoin:round}.ic-box{stroke:#1e293b;stroke-width:1.6;fill:#f8fafc;stroke-linejoin:round}.pin{fill:#64748b;stroke:none;opacity:0.45}.pin-hit{fill:transparent;stroke:none}.wire{stroke:#15803d;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.junc{fill:#15803d;stroke:none}.pwr-wire{stroke:#b91c1c;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.pwr-sym{stroke:#b91c1c;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.pwr-lbl{fill:#b91c1c;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:8px;font-weight:600}.gnd-wire{stroke:#334155;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.gnd-sym{stroke:#334155;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}.gnd-lbl{fill:#334155;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:600}.ratsnest{stroke:#d97706;stroke-width:1.2;stroke-dasharray:4 3;fill:none}.lbl-ref{fill:#0f172a;font-family:'Segoe UI',Arial,'Liberation Sans',sans-serif;font-size:8.5px;font-weight:600}.lbl-val{fill:#475569;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:400}.pin-lbl{fill:#334155;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:500}.sym-mark{fill:#1e293b;font-family:Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:7.5px;font-weight:600}.empty-msg{fill:#64748b;font-family:'Segoe UI',Arial,'Liberation Sans',sans-serif;font-size:11px;font-weight:500}.hl .sym,.hl .ic-box,.hl .wire,.hl .pwr-wire,.hl .pwr-sym,.hl .gnd-wire,.hl .gnd-sym,.hl .ratsnest{stroke:#2563eb;stroke-width:2.6}.hl .sym-fill,.hl .junc{fill:#2563eb;stroke:#2563eb}.hl .lbl-ref,.hl .lbl-val,.hl .pwr-lbl,.hl .gnd-lbl{fill:#2563eb}.hl .pin{fill:#2563eb;opacity:0.9}</style><rect x="34" y="-147" width="609" height="291" class="bg"/><g class="wires"><g data-net="GND"><path d="M 70 20 L 70 30" class="gnd-wire"/><path d="M 63 30 L 77 30 M 65.5 33.5 L 74.5 33.5 M 68 37 L 72 37" class="gnd-sym"/><path d="M 260 0 L 260 10" class="gnd-wire"/><path d="M 253 10 L 267 10 M 255.5 13.5 L 264.5 13.5 M 258 17 L 262 17" class="gnd-sym"/><path d="M 350 100 L 350 110" class="gnd-wire"/><path d="M 343 110 L 357 110 M 345.5 113.5 L 354.5 113.5 M 348 117 L 352 117" class="gnd-sym"/><path d="M 600 -60 L 610 -60 L 610 -52" class="gnd-wire"/><path d="M 603 -52 L 617 -52 M 605.5 -48.5 L 614.5 -48.5 M 608 -45 L 612 -45" class="gnd-sym"/></g><g data-net="IN"><path d="M 210 -50 L 300 -50" class="wire"/><path d="M 260 -50 L 260 -40" class="wire"/><circle cx="260" cy="-50" r="2.2" class="junc"/></g><g data-net="LA"><path d="M 500 -60 L 560 -60" class="wire"/></g><g data-net="VCC"><path d="M 70 -20 L 70 -30" class="pwr-wire"/><path d="M 64 -30 L 76 -30" class="pwr-sym"/><text x="70" y="-34" text-anchor="middle" class="pwr-lbl">VCC</text><path d="M 170 -50 L 160 -50" class="pwr-wire"/><path d="M 160 -55 L 160 -45" class="pwr-sym"/><text x="156" y="-47.5" text-anchor="end" class="pwr-lbl">VCC</text><path d="M 300 -70 L 290 -70" class="pwr-wire"/><path d="M 290 -75 L 290 -65" class="pwr-sym"/><text x="286" y="-67.5" text-anchor="end" class="pwr-lbl">VCC</text><path d="M 350 -100 L 350 -110" class="pwr-wire"/><path d="M 344 -110 L 356 -110" class="pwr-sym"/><text x="350" y="-114" text-anchor="middle" class="pwr-lbl">VCC</text></g><g data-net="Y"><path d="M 400 -60 L 460 -60" class="wire"/></g></g><g class="components"><g data-ref="BAT1"><g transform="translate(70,0)"><path d="M 0 -20 L 0 -6 M -10 -6 L 10 -6 M -5 -2 L 5 -2 M -10 2 L 10 2 M -5 6 L 5 6 M 0 6 L 0 20" class="sym"/></g><text x="62.5" y="-8.5" text-anchor="middle" class="sym-mark">+</text><text x="83" y="-2" text-anchor="start" class="lbl-ref">BAT1</text><text x="83" y="8" text-anchor="start" class="lbl-val">5V</text><circle cx="70" cy="-20" r="1.6" class="pin" data-pin="BAT1.+"/><circle cx="70" cy="20" r="1.6" class="pin" data-pin="BAT1.-"/></g><g data-ref="D1"><g transform="translate(580,-60)"><path d="M -20 0 L -6 0 M 6 0 L 20 0" class="sym"/><path d="M -6 -7 L 6 0 L -6 7 Z" class="sym"/><path d="M 6 -7 L 6 7" class="sym"/><path d="M -2 -9 L 4 -15 M 1.5 -15 L 4 -15 L 4 -12.5 M 3 -8 L 9 -14 M 6.5 -14 L 9 -14 L 9 -11.5" class="sym"/></g><text x="580" y="-44" text-anchor="middle" class="lbl-ref">D1</text><text x="580" y="-34" text-anchor="middle" class="lbl-val">red</text><circle cx="560" cy="-60" r="1.6" class="pin" data-pin="D1.A"/><circle cx="600" cy="-60" r="1.6" class="pin" data-pin="D1.K"/></g><g data-ref="R1"><g transform="translate(480,-60)"><path d="M -20 0 L -12 0 L -10 -4.5 L -6 4.5 L -2 -4.5 L 2 4.5 L 6 -4.5 L 10 4.5 L 12 0 L 20 0" class="sym"/></g><text x="480" y="-68.5" text-anchor="middle" class="lbl-ref">R1</text><text x="480" y="-45.5" text-anchor="middle" class="lbl-val">330</text><circle cx="460" cy="-60" r="1.6" class="pin" data-pin="R1.1"/><circle cx="500" cy="-60" r="1.6" class="pin" data-pin="R1.2"/></g><g data-ref="R2"><g transform="translate(260,-20) rotate(90)"><path d="M -20 0 L -12 0 L -10 -4.5 L -6 4.5 L -2 -4.5 L 2 4.5 L 6 -4.5 L 10 4.5 L 12 0 L 20 0" class="sym"/></g><text x="268.5" y="-22" text-anchor="start" class="lbl-ref">R2</text><text x="268.5" y="-12" text-anchor="start" class="lbl-val">10k</text><circle cx="260" cy="-40" r="1.6" class="pin" data-pin="R2.1"/><circle cx="260" cy="0" r="1.6" class="pin" data-pin="R2.2"/></g><g data-ref="SW1"><g transform="translate(190,-50)"><path d="M -20 0 L -10 0 M 10 0 L 20 0" class="sym"/><circle cx="-8" cy="0" r="2" class="sym"/><circle cx="8" cy="0" r="2" class="sym"/><path d="M -9 -7 L 9 -7 M 0 -7 L 0 -13 M -4 -13 L 4 -13" class="sym"/></g><text x="190" y="-37.5" text-anchor="middle" class="lbl-ref">SW1</text><text x="190" y="-27.5" text-anchor="middle" class="lbl-val">released</text><circle cx="170" cy="-50" r="1.6" class="pin" data-pin="SW1.1"/><circle cx="210" cy="-50" r="1.6" class="pin" data-pin="SW1.2"/></g><g data-ref="U1"><rect x="312" y="-88" width="76" height="176" rx="2" class="ic-box"/><path d="M 300 -70 L 312 -70" class="sym"/><text x="316" y="-67.5" text-anchor="start" class="pin-lbl">1A</text><path d="M 300 -50 L 312 -50" class="sym"/><text x="316" y="-47.5" text-anchor="start" class="pin-lbl">1B</text><path d="M 300 -30 L 312 -30" class="sym"/><text x="316" y="-27.5" text-anchor="start" class="pin-lbl">2A</text><path d="M 300 -10 L 312 -10" class="sym"/><text x="316" y="-7.5" text-anchor="start" class="pin-lbl">2B</text><path d="M 300 10 L 312 10" class="sym"/><text x="316" y="12.5" text-anchor="start" class="pin-lbl">3A</text><path d="M 300 30 L 312 30" class="sym"/><text x="316" y="32.5" text-anchor="start" class="pin-lbl">3B</text><path d="M 300 50 L 312 50" class="sym"/><text x="316" y="52.5" text-anchor="start" class="pin-lbl">4A</text><path d="M 300 70 L 312 70" class="sym"/><text x="316" y="72.5" text-anchor="start" class="pin-lbl">4B</text><path d="M 400 -60 L 388 -60" class="sym"/><text x="384" y="-57.5" text-anchor="end" class="pin-lbl">1Y</text><path d="M 400 -20 L 388 -20" class="sym"/><text x="384" y="-17.5" text-anchor="end" class="pin-lbl">2Y</text><path d="M 400 20 L 388 20" class="sym"/><text x="384" y="22.5" text-anchor="end" class="pin-lbl">3Y</text><path d="M 400 60 L 388 60" class="sym"/><text x="384" y="62.5" text-anchor="end" class="pin-lbl">4Y</text><path d="M 350 -100 L 350 -88" class="sym"/><text x="350" y="-78" text-anchor="middle" class="pin-lbl">VCC</text><path d="M 350 100 L 350 88" class="sym"/><text x="350" y="84" text-anchor="middle" class="pin-lbl">GND</text><text x="312" y="-102" text-anchor="start" class="lbl-ref">U1</text><text x="312" y="-92" text-anchor="start" class="lbl-val">74hc00</text><circle cx="300" cy="-70" r="1.6" class="pin" data-pin="U1.1A"/><circle cx="300" cy="-50" r="1.6" class="pin" data-pin="U1.1B"/><circle cx="300" cy="-30" r="1.6" class="pin" data-pin="U1.2A"/><circle cx="300" cy="-10" r="1.6" class="pin" data-pin="U1.2B"/><circle cx="300" cy="10" r="1.6" class="pin" data-pin="U1.3A"/><circle cx="300" cy="30" r="1.6" class="pin" data-pin="U1.3B"/><circle cx="300" cy="50" r="1.6" class="pin" data-pin="U1.4A"/><circle cx="300" cy="70" r="1.6" class="pin" data-pin="U1.4B"/><circle cx="400" cy="-60" r="1.6" class="pin" data-pin="U1.1Y"/><circle cx="400" cy="-20" r="1.6" class="pin" data-pin="U1.2Y"/><circle cx="400" cy="20" r="1.6" class="pin" data-pin="U1.3Y"/><circle cx="400" cy="60" r="1.6" class="pin" data-pin="U1.4Y"/><circle cx="350" cy="-100" r="1.6" class="pin" data-pin="U1.VCC"/><circle cx="350" cy="100" r="1.6" class="pin" data-pin="U1.GND"/></g></g></svg>"`);
  });
});
