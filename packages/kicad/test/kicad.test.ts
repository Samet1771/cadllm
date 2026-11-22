// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { pads as pcbPads, type Footprint } from '@cadllm/pcb';
import {
  atomNumber,
  atomString,
  deterministicUuid,
  exportKicadMod,
  exportKicadPcb,
  findChild,
  findChildren,
  headOf,
  importKicadMod,
  isList,
  num,
  parseSexpr,
  parseSexprAll,
  printSexpr,
  str,
  sym,
  tokenizeSexpr,
  type SexprList,
} from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);
const fixturesDir = resolve(import.meta.dirname, './fixtures');
const examplesDir = resolve(import.meta.dirname, '../../../examples');

function isPadsStubbed(): boolean {
  try {
    const doc = loadCircuit(readFileSync(resolve(examplesDir, 'led-pcb.cnl'), 'utf8'), lib);
    pcbPads(doc.read);
    return false;
  } catch (err) {
    return err instanceof Error && /not implemented/i.test(err.message);
  }
}

describe('S-expression tokenizer, parser, and printer', () => {
  it('tokenizes and parses strings with escapes, numbers, symbols, and nested lists', () => {
    const src = '(footprint "Test \\"A\\"\\nLine2\\t\\\\End" (version 20241229) (at -3.81 2.54 1e-2) (pkg 0805 *.Cu))';
    const tokens = tokenizeSexpr(src);
    expect(tokens[0]).toEqual({ kind: 'lparen' });
    expect(tokens[1]).toEqual({ kind: 'symbol', value: 'footprint' });
    expect(tokens[2]).toEqual({ kind: 'string', value: 'Test "A"\nLine2\t\\End' });

    const ast = parseSexpr(src);
    expect(isList(ast)).toBe(true);
    const list = ast as SexprList;
    expect(headOf(list)).toBe('footprint');
    expect(atomString(list[1])).toBe('Test "A"\nLine2\t\\End');

    const ver = findChild(list, 'version')!;
    expect(atomNumber(ver[1])).toBe(20241229);

    const at = findChild(list, 'at')!;
    expect([atomNumber(at[1]), atomNumber(at[2]), atomNumber(at[3])]).toEqual([-3.81, 2.54, 0.01]);

    const pkg = findChild(list, 'pkg')!;
    // 0805 has a leading zero so it must remain a symbol rather than losing its leading zero as 805
    expect(pkg[1]).toEqual({ kind: 'symbol', value: '0805' });
    expect(pkg[2]).toEqual({ kind: 'symbol', value: '*.Cu' });
  });

  it('round-trips compact and pretty-printed S-expressions', () => {
    const expr: SexprList = [
      sym('kicad_pcb'),
      [sym('version'), num(20241229)],
      [sym('generator'), str('cadllm')],
      [sym('quote_test'), str('a "quoted" \\ backslash \n newline \r cr \t tab')],
      [sym('coords'), num(0), num(-12.7), num(3.1415)],
      [sym('nested'), [sym('inner'), sym('F.Cu'), str('')]],
    ];

    const compact = printSexpr(expr);
    expect(parseSexpr(compact)).toEqual(expr);
    expect(printSexpr(parseSexpr(compact))).toBe(compact);

    const pretty = printSexpr(expr, { pretty: true });
    expect(pretty).toContain('\n  (version 20241229)');
    expect(parseSexpr(pretty)).toEqual(expr);
  });

  it('parses multiple top-level expressions and rejects malformed syntax', () => {
    const multi = parseSexprAll('(net 0 "") (net 1 "VCC")');
    expect(multi).toHaveLength(2);
    expect(() => parseSexpr('')).toThrow(/Empty/);
    expect(() => parseSexpr('(a b')).toThrow(/Unclosed/);
    expect(() => parseSexpr(')')).toThrow(/Unexpected "\)"/);
    expect(() => parseSexpr('(a) (b)')).toThrow(/Trailing tokens/);
    expect(() => parseSexpr('("unterminated)')).toThrow(/Unterminated string/);
    expect(() => parseSexpr('("escape\\')).toThrow(/Unterminated string escape/);
  });
});

describe('importKicadMod (.kicad_mod importer)', () => {
  it('imports hand-written DIP-8 fixture with TH pads, silk lines/arc/circle, and courtyard', () => {
    const text = readFileSync(resolve(fixturesDir, 'DIP-8.kicad_mod'), 'utf8');
    const fp = importKicadMod(text);

    expect(fp.name).toBe('DIP-8_W7.62mm');
    expect(fp.warnings).toEqual([]);
    expect(fp.pads).toHaveLength(8);
    expect(fp.pads[0]).toEqual({
      id: '1',
      shape: 'rect',
      at: [-3.81, -3.81],
      size: [1.6, 1.6],
      drill: 0.8,
      layers: 'TH',
    });
    expect(fp.pads[1]?.shape).toBe('oval');
    expect(fp.pads[1]?.at).toEqual([-3.81, -1.27]);
    expect(fp.pads[4]?.at).toEqual([3.81, 3.81]);
    expect(fp.pads[7]?.at).toEqual([3.81, -3.81]);

    expect(fp.silk.filter(s => s.kind === 'line')).toHaveLength(5);
    const arc = fp.silk.find(s => s.kind === 'arc');
    expect(arc).toBeDefined();
    if (arc && arc.kind === 'arc') {
      expect(arc.at[0]).toBeCloseTo(0, 3);
      expect(arc.at[1]).toBeCloseTo(-4.8, 3);
      expect(arc.r).toBeCloseTo(0.8, 3);
    }
    const circle = fp.silk.find(s => s.kind === 'circle');
    expect(circle).toEqual({ kind: 'circle', at: [-2.2, -3.81], r: 0.25, width: 0.12 });

    expect(fp.courtyard).toEqual([10.2, 10.2]);
    expect(fp.origin).toEqual([0, 0]);
    expect(fp.courtyardBounds).toBeUndefined();
  });

  it('imports hand-written R_Axial fixture with 10.16mm pitch and asymmetric courtyard bounds', () => {
    const text = readFileSync(resolve(fixturesDir, 'R_Axial.kicad_mod'), 'utf8');
    const fp = importKicadMod(text);

    expect(fp.name).toBe('R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal');
    expect(fp.warnings).toEqual([]);
    expect(fp.pads).toEqual([
      { id: '1', shape: 'circle', at: [0, 0], size: [1.8, 1.8], drill: 0.9, layers: 'TH' },
      { id: '2', shape: 'oval', at: [10.16, 0], size: [1.8, 1.8], drill: 0.9, layers: 'TH' },
    ]);
    expect(fp.silk).toEqual([
      { kind: 'rect', at: [1.8, -1.37], size: [6.56, 2.74], width: 0.12 },
      { kind: 'line', from: [1.14, 0], to: [1.8, 0], width: 0.12 },
      { kind: 'line', from: [8.36, 0], to: [9.02, 0], width: 0.12 },
    ]);
    expect(fp.courtyard).toEqual([12.46, 3]);
    expect(fp.courtyardBounds).toEqual({ minX: -1.15, minY: -1.5, maxX: 11.31, maxY: 1.5 });
  });

  it('handles legacy module root, SMD F/B pads, roundrect_rratio, pad rotation, np_thru_hole, fp_poly, oval drills, and unknown items with warnings', () => {
    const mod = `
      (module Legacy_Test (layer F.Cu)
        (fp_poly (pts (xy -1 -1) (xy 1 -1) (xy 0 1)) (layer F.SilkS) (width 0.15))
        (fp_arc (start 0 0) (end 1 0) (angle 90) (layer F.SilkS) (width 0.12))
        (fp_line (start -2 -2) (end 2 2) (layer F.Fab) (width 0.1))
        (fp_rect (start -3 -2) (end 3 2) (layer F.CrtYd) (width 0.05))
        (pad 1 smd roundrect (at -1.5 0 90) (size 0.8 1.4) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.2))
        (pad 2 smd rect (at 1.5 0) (size 1.2 0.8) (layers B.Cu B.Mask))
        (pad 3 thru_hole oval (at 0 1.5) (size 1.6 2.0) (drill oval 0.8 1.2) (layers *.Cu *.Mask))
        (pad "" np_thru_hole circle (at 0 -1.5) (size 1.0 1.0) (drill 1.0) (layers *.Cu *.Mask))
        (pad 4 smd trapezoid (at 2 2) (size 1 1) (layers F.Cu))
        (model "part.wrl" (offset (xyz 0 0 0)))
        (zone (net 0))
      )
    `;
    const collectedWarnings: string[] = [];
    const fp = importKicadMod(mod, { warnings: collectedWarnings });

    expect(fp.name).toBe('Legacy_Test');
    expect(fp.courtyard).toEqual([6, 4]);
    expect(fp.pads).toHaveLength(5);

    // Pad 1: rotated 90 deg -> size [0.8, 1.4] becomes [1.4, 0.8], roundrect_rratio 0.2, layer F
    expect(fp.pads[0]).toEqual({
      id: '1',
      shape: 'roundrect',
      at: [-1.5, 0],
      size: [1.4, 0.8],
      layers: 'F',
      roundRadius: 0.2,
    });
    // Pad 2: B.Cu -> layer B
    expect(fp.pads[1]).toEqual({
      id: '2',
      shape: 'rect',
      at: [1.5, 0],
      size: [1.2, 0.8],
      layers: 'B',
    });
    // Pad 3: oval drill 0.8x1.2 -> approximated to 0.8 with warning
    expect(fp.pads[2]).toEqual({
      id: '3',
      shape: 'oval',
      at: [0, 1.5],
      size: [1.6, 2],
      drill: 0.8,
      layers: 'TH',
    });
    // NPTH pad
    expect(fp.pads[3]).toEqual({
      id: '',
      shape: 'circle',
      at: [0, -1.5],
      size: [1, 1],
      drill: 1,
      layers: 'TH',
    });
    // Unsupported trapezoid pad falls back to rect
    expect(fp.pads[4]?.shape).toBe('rect');

    // Silk includes fp_poly and legacy fp_arc
    expect(fp.silk).toContainEqual({
      kind: 'poly',
      points: [[-1, -1], [1, -1], [0, 1]],
      closed: true,
      width: 0.15,
    });
    expect(fp.silk.some(s => s.kind === 'arc')).toBe(true);

    // Warnings check
    expect(fp.warnings).toEqual(collectedWarnings);
    expect(fp.warnings.some(w => /oval drill/i.test(w))).toBe(true);
    expect(fp.warnings.some(w => /F\.Fab/i.test(w))).toBe(true);
    expect(fp.warnings.some(w => /trapezoid/i.test(w))).toBe(true);
    expect(fp.warnings.some(w => /"model"/i.test(w))).toBe(true);
    expect(fp.warnings.some(w => /"zone"/i.test(w))).toBe(true);
  });

  it('round-trips a Footprint through exportKicadMod and importKicadMod', () => {
    const dip8 = importKicadMod(readFileSync(resolve(fixturesDir, 'DIP-8.kicad_mod'), 'utf8'));
    const exported = exportKicadMod(dip8);
    const reimported = importKicadMod(exported);
    expect(reimported.name).toBe(dip8.name);
    expect(reimported.pads).toEqual(dip8.pads);
    expect(reimported.courtyard).toEqual(dip8.courtyard);
    expect(reimported.silk).toHaveLength(dip8.silk.length);
  });
});

describe('exportKicadPcb (.kicad_pcb exporter) & structural validation', () => {
  const rAxial = importKicadMod(readFileSync(resolve(fixturesDir, 'R_Axial.kicad_mod'), 'utf8'));
  const handFootprints: Record<string, Footprint> = {
    WireLeads: {
      name: 'WireLeads',
      pads: [
        { id: '1', shape: 'circle', at: [0, 0], size: [2.0, 2.0], drill: 1.0, layers: 'TH' },
        { id: '2', shape: 'circle', at: [0, 2.54], size: [2.0, 2.0], drill: 1.0, layers: 'TH' },
      ],
      silk: [{ kind: 'rect', at: [-1.5, -1.5], size: [3, 5.54], width: 0.12 }],
      courtyard: [4, 6.54],
      origin: [0, 0],
    },
    'LED_D5.0mm': {
      name: 'LED_D5.0mm',
      pads: [
        { id: '1', shape: 'rect', at: [-1.27, 0], size: [1.8, 1.8], drill: 0.8, layers: 'TH' },
        { id: '2', shape: 'oval', at: [1.27, 0], size: [1.8, 1.8], drill: 0.8, layers: 'TH' },
      ],
      silk: [{ kind: 'circle', at: [0, 0], r: 2.5, width: 0.12 }],
      courtyard: [6, 6],
      origin: [0, 0],
    },
    'Header_1x02_P2.54mm': {
      name: 'Header_1x02_P2.54mm',
      pads: [
        { id: '1', shape: 'rect', at: [0, 0], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
        { id: '2', shape: 'roundrect', at: [0, 2.54], size: [1.7, 1.7], drill: 1.0, layers: 'TH', roundRadius: 0.25 },
      ],
      silk: [{ kind: 'rect', at: [-1.27, -1.27], size: [2.54, 5.08], width: 0.12 }],
      courtyard: [3.5, 6],
      origin: [0, 0],
    },
    'THT-axial': {
      ...rAxial,
      name: 'THT-axial',
    },
  };

  it('exports KiCad 9 .kicad_pcb and passes full S-expression structural validation', () => {
    const doc = loadCircuit(readFileSync(resolve(examplesDir, 'led-pcb.cnl'), 'utf8'), lib);
    doc.transact(tx => {
      applyEdit(
        tx,
        [
          'D1 @pcb:22,10,90 bottom',
          'track VCC F 0.4 5,6 10,6 14,10',
          'track LA B 0.25 14,10 22,10',
          'track GND F 0.4 5,17.54 22,12.54',
          'via LA 18,10 size=0.6 drill=0.3',
        ].join('\n'),
      );
    });

    const pcbText = exportKicadPcb(doc.read, { footprints: handFootprints });
    // Deterministic check
    expect(exportKicadPcb(doc.read, { footprints: handFootprints })).toBe(pcbText);
    expect(deterministicUuid('fp:R1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

    // Parse back with our S-expr parser and validate structure
    const root = parseSexpr(pcbText);
    expect(isList(root)).toBe(true);
    const pcbList = root as SexprList;
    expect(headOf(pcbList)).toBe('kicad_pcb');

    const version = findChild(pcbList, 'version');
    expect(atomNumber(version?.[1])).toBe(20241229);

    const generator = findChild(pcbList, 'generator');
    expect(atomString(generator?.[1])).toBe('cadllm');

    expect(findChild(pcbList, 'general')).toBeDefined();
    expect(findChild(pcbList, 'layers')).toBeDefined();
    expect(findChild(pcbList, 'setup')).toBeDefined();

    // Validate net list: unique net numbers, net 0 = ""
    const netNodes = findChildren(pcbList, 'net');
    expect(netNodes).toHaveLength(4); // 0:"", 1:"GND", 2:"LA", 3:"VCC"
    const netMap = new Map<number, string>();
    for (const nNode of netNodes) {
      const nNum = atomNumber(nNode[1]);
      const nName = atomString(nNode[2]);
      expect(nNum).toBeDefined();
      expect(nName).toBeDefined();
      expect(netMap.has(nNum!)).toBe(false);
      netMap.set(nNum!, nName!);
    }
    expect(netMap.get(0)).toBe('');
    expect([...netMap.values()].sort()).toEqual(['', 'GND', 'LA', 'VCC']);

    // Validate Edge.Cuts board outline (30x20 rectangle -> 4 gr_line items)
    const grLines = findChildren(pcbList, 'gr_line');
    expect(grLines).toHaveLength(4);
    for (const gl of grLines) {
      const layer = findChild(gl, 'layer');
      expect(atomString(layer?.[1])).toBe('Edge.Cuts');
    }

    // Validate footprints and pads
    const fpNodes = findChildren(pcbList, 'footprint');
    expect(fpNodes).toHaveLength(4); // BAT1, D1, J1, R1

    // Check D1 placement: @22,10,90 bottom -> layer "B.Cu", (at 22 10 90)
    const d1Node = fpNodes.find(f => atomString(f[1]) === 'LED_D5.0mm')!;
    expect(d1Node).toBeDefined();
    expect(atomString(findChild(d1Node, 'layer')?.[1])).toBe('B.Cu');
    const d1At = findChild(d1Node, 'at')!;
    expect([atomNumber(d1At[1]), atomNumber(d1At[2]), atomNumber(d1At[3])]).toEqual([22, 10, 90]);

    let totalPads = 0;
    let padsWithAssignedNet = 0;
    for (const fpNode of fpNodes) {
      const padNodes = findChildren(fpNode, 'pad');
      for (const pNode of padNodes) {
        totalPads++;
        const pNet = findChild(pNode, 'net');
        expect(pNet).toBeDefined();
        const netNum = atomNumber(pNet?.[1]);
        const netName = atomString(pNet?.[2]);
        expect(netNum).toBeDefined();
        // Every pad net must exist in the top-level net table
        expect(netMap.has(netNum!)).toBe(true);
        expect(netMap.get(netNum!)).toBe(netName);
        if (netNum! > 0) padsWithAssignedNet++;
      }

      // Verify top-side footprint inside .kicad_pcb can be parsed back by importKicadMod
      if (atomString(findChild(fpNode, 'layer')?.[1]) === 'F.Cu') {
        const reimported = importKicadMod(printSexpr(fpNode));
        expect(reimported.pads.length).toBeGreaterThan(0);
        expect(reimported.warnings).toEqual([]);
      }
    }
    expect(totalPads).toBe(8);
    expect(padsWithAssignedNet).toBe(8);

    // Validate track segments: 3 tracks (first has 3 points = 2 segments; second has 2 points = 1 segment; third has 2 points = 1 segment) -> 4 segments total
    const segNodes = findChildren(pcbList, 'segment');
    expect(segNodes).toHaveLength(4);
    for (const seg of segNodes) {
      const layer = atomString(findChild(seg, 'layer')?.[1]);
      expect(layer === 'F.Cu' || layer === 'B.Cu').toBe(true);
      const width = atomNumber(findChild(seg, 'width')?.[1]);
      expect(width).toBeGreaterThan(0);
      const netNum = atomNumber(findChild(seg, 'net')?.[1]);
      expect(netNum).toBeDefined();
      expect(netMap.has(netNum!)).toBe(true);
    }

    // Validate vias
    const viaNodes = findChildren(pcbList, 'via');
    expect(viaNodes).toHaveLength(1);
    const via = viaNodes[0]!;
    expect([atomNumber(findChild(via, 'at')?.[1]), atomNumber(findChild(via, 'at')?.[2])]).toEqual([18, 10]);
    expect(atomNumber(findChild(via, 'size')?.[1])).toBe(0.6);
    expect(atomNumber(findChild(via, 'drill')?.[1])).toBe(0.3);
    const viaNetNum = atomNumber(findChild(via, 'net')?.[1]);
    expect(netMap.get(viaNetNum!)).toBe('LA');
  });

  it.skipIf(isPadsStubbed())('exports examples/led-pcb.cnl end-to-end using @cadllm/pcb footprint() and pads()', () => {
    const doc = loadCircuit(readFileSync(resolve(examplesDir, 'led-pcb.cnl'), 'utf8'), lib);
    const text = exportKicadPcb(doc.read);
    const root = parseSexpr(text) as SexprList;
    expect(headOf(root)).toBe('kicad_pcb');
    expect(atomNumber(findChild(root, 'version')?.[1])).toBe(20241229);
    expect(atomString(findChild(root, 'generator')?.[1])).toBe('cadllm');

    const nets = findChildren(root, 'net');
    expect(nets).toHaveLength(4);
    const netTable = new Map<number, string>();
    for (const n of nets) {
      const id = atomNumber(n[1])!;
      const name = atomString(n[2])!;
      expect(netTable.has(id)).toBe(false);
      netTable.set(id, name);
    }
    expect(netTable.get(0)).toBe('');

    const fps = findChildren(root, 'footprint');
    expect(fps).toHaveLength(4);
    let connectedPads = 0;
    for (const fp of fps) {
      for (const pad of findChildren(fp, 'pad')) {
        const netExpr = findChild(pad, 'net')!;
        const netNum = atomNumber(netExpr[1])!;
        const netName = atomString(netExpr[2])!;
        expect(netTable.get(netNum)).toBe(netName);
        if (netNum > 0) connectedPads++;
      }
    }
    expect(connectedPads).toBe(8);
    expect(findChildren(root, 'gr_line')).toHaveLength(4);
  });
});
