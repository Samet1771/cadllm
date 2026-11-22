// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { plot, read, renderBoard, renderLayers, stringifySvg } from '@tracespace/core';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { autoPlacePcb, pads, route, type Footprint, type PadInstance } from '@cadllm/pcb';
import { generateFabPreview } from '../scripts/fab-preview.ts';
import { bom, excellon, fabZip, gerbers, pickAndPlace } from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPcbImplemented(): boolean {
  try {
    const doc = loadCircuit(readFileSync(resolve(import.meta.dirname, '../../../examples/led-pcb.cnl'), 'utf8'), lib);
    pads(doc.read);
    route(doc.read);
    return true;
  } catch (err) {
    if (err instanceof Error && /not implemented yet/i.test(err.message)) return false;
    throw err;
  }
}

function countGerberFlashes(gerberText: string): number {
  return gerberText.split('\n').filter(l => /D03\*$/.test(l.trim())).length;
}

function countGerberMoves(gerberText: string): number {
  return gerberText.split('\n').filter(l => /D02\*$/.test(l.trim())).length;
}

interface PlottedChild {
  type: string;
  segments?: unknown[];
}

function getPlotChildren(plotted: ReturnType<typeof plot>, layerId: string): PlottedChild[] {
  return (plotted.plotTreesById[layerId]?.children ?? []) as PlottedChild[];
}

describe('@cadllm/export unit tests (hand-built pad/track/via data)', () => {
  const handPads: PadInstance[] = [
    // TH circle pad & TH rect pad (J1)
    {
      ref: 'J1', compId: 'c1', pinId: '1', pinLabel: 'J1.+', netId: 'n1', net: 'VCC',
      shape: 'rect', at: [5, 6], size: [1.7, 1.7], rot: 0, drill: 1.0, layers: 'TH',
    },
    {
      ref: 'J1', compId: 'c1', pinId: '2', pinLabel: 'J1.-', netId: 'n2', net: 'GND',
      shape: 'circle', at: [5, 8.54], size: [1.7, 1.7], rot: 0, drill: 1.0, layers: 'TH',
    },
    // Top SMD roundrect pads (R1) at 45 deg rotation
    {
      ref: 'R1', compId: 'c2', pinId: '1', pinLabel: 'R1.1', netId: 'n1', net: 'VCC',
      shape: 'roundrect', at: [14, 10], size: [1.2, 1.4], rot: 45, layers: 'F', roundRadius: 0.25,
    },
    {
      ref: 'R1', compId: 'c2', pinId: '2', pinLabel: 'R1.2', netId: 'n3', net: 'LA',
      shape: 'roundrect', at: [16, 10], size: [1.2, 1.4], rot: 45, layers: 'F', roundRadius: 0.25,
    },
    // Bottom SMD oval pads (D1) at 90 deg and 30 deg rotation
    {
      ref: 'D1', compId: 'c3', pinId: '1', pinLabel: 'D1.A', netId: 'n3', net: 'LA',
      shape: 'oval', at: [22, 10], size: [1.6, 1.2], rot: 90, layers: 'B',
    },
    {
      ref: 'D1', compId: 'c3', pinId: '2', pinLabel: 'D1.K', netId: 'n2', net: 'GND',
      shape: 'oval', at: [22, 12.54], size: [1.6, 1.2], rot: 30, layers: 'B',
    },
    // NPTH mounting hole pad
    {
      ref: 'J1', compId: 'c1', pinId: 'MP', pinLabel: 'J1.MP',
      shape: 'circle', at: [5, 3], size: [2.2, 2.2], rot: 0, drill: 2.0, layers: 'F',
    },
  ];

  const handFootprints: Record<string, Footprint> = {
    'Header_1x02_P2.54mm': {
      name: 'Header_1x02_P2.54mm',
      pads: [],
      silk: [
        { kind: 'rect', at: [0, 1.27], size: [2.54, 5.08], width: 0.15 },
        { kind: 'circle', at: [-1.8, 0], r: 0.25, width: 0.15 },
      ],
      courtyard: [3.5, 6.0],
      origin: [0, 0],
    },
    '0805': {
      name: '0805',
      pads: [],
      silk: [
        { kind: 'line', from: [-1, -0.8], to: [1, -0.8], width: 0.15 },
        { kind: 'line', from: [-1, 0.8], to: [1, 0.8], width: 0.15 },
      ],
      courtyard: [3.0, 2.0],
      origin: [0, 0],
    },
    'LED_D5.0mm': {
      name: 'LED_D5.0mm',
      pads: [],
      silk: [
        { kind: 'arc', at: [0, 1.27], r: 2.5, startDeg: 30, endDeg: 330, width: 0.15 },
        { kind: 'poly', points: [[2.16, 0.02], [2.16, 2.52]], closed: false, width: 0.15 },
      ],
      courtyard: [6.0, 6.0],
      origin: [0, 0],
    },
  };

  function makeRoutedDoc() {
    const cnl = [
      'cnl 1',
      'meta name=hand-board',
      '',
      '[circuit]',
      'D1 led red footprint=LED_D5.0mm',
      'J1 dc_supply 5V footprint=Header_1x02_P2.54mm',
      'R1 res 330 footprint=0805',
      'R2 res 330 footprint=0805',
      'V1 vcc_symbol',
      '',
      'GND: D1.K J1.-',
      'LA:  D1.A R1.2 R2.2',
      'VCC: J1.+ R1.1 R2.1 V1.VCC',
      '',
      '[pcb]',
      'D1 @22,10,90 bottom',
      'J1 @5,6',
      'R1 @14,10,45 top',
      'R2 @14,15,0 top',
      'board 30x20',
      'rules clearance=0.2 track=0.25 via=0.6 drill=0.3',
      'track VCC F 0.4 5,6 10,6 14,10',
      'track LA F 0.25 16,10 19,10',
      'track LA B 0.25 19,10 22,10',
      'track GND B 0.4 5,8.54 22,12.54',
      'via LA 19,10 size=0.6 drill=0.3',
    ].join('\n');
    return loadCircuit(cnl, lib);
  }

  it('generates RS-274X Gerbers with X2 attributes, 4.6 mm format, macros, and closed outline', () => {
    const doc = makeRoutedDoc();
    const gbr = gerbers(doc.read, { pads: handPads, footprints: handFootprints });

    expect(Object.keys(gbr).sort()).toEqual([
      'hand-board-B_Cu.gbr',
      'hand-board-B_Mask.gbr',
      'hand-board-B_Silkscreen.gbr',
      'hand-board-Edge_Cuts.gbr',
      'hand-board-F_Cu.gbr',
      'hand-board-F_Mask.gbr',
      'hand-board-F_Silkscreen.gbr',
    ]);

    for (const content of Object.values(gbr)) {
      expect(content).toContain('%FSLAX46Y46*%');
      expect(content).toContain('%MOMM*%');
      expect(content).not.toContain('TF.CreationDate');
      expect(content.trim().endsWith('M02*')).toBe(true);
    }

    expect(gbr['hand-board-F_Cu.gbr']).toContain('%TF.FileFunction,Copper,L1,Top*%');
    expect(gbr['hand-board-B_Cu.gbr']).toContain('%TF.FileFunction,Copper,L2,Bot*%');
    expect(gbr['hand-board-F_Mask.gbr']).toContain('%TF.FileFunction,Soldermask,Top*%');
    expect(gbr['hand-board-B_Mask.gbr']).toContain('%TF.FileFunction,Soldermask,Bot*%');
    expect(gbr['hand-board-F_Silkscreen.gbr']).toContain('%TF.FileFunction,Legend,Top*%');
    expect(gbr['hand-board-B_Silkscreen.gbr']).toContain('%TF.FileFunction,Legend,Bot*%');
    expect(gbr['hand-board-Edge_Cuts.gbr']).toContain('%TF.FileFunction,Profile,NP*%');

    // Macro aperture emitted for roundrect on F_Cu and rotated 30-deg oval on B_Cu
    expect(gbr['hand-board-F_Cu.gbr']).toMatch(/%AMRR\d+\*/);
    expect(gbr['hand-board-B_Cu.gbr']).toMatch(/%AMRR\d+\*/);

    // Flash counts:
    // F_Cu: 2 TH pads + 2 F SMD pads + 1 F NPTH pad + 1 via = 6 flashes
    // B_Cu: 2 TH pads + 2 B SMD pads + 1 via = 5 flashes
    // F_Mask: 2 TH pads + 2 F SMD pads + 1 F NPTH pad = 5 flashes
    // B_Mask: 2 TH pads + 2 B SMD pads = 4 flashes
    expect(countGerberFlashes(gbr['hand-board-F_Cu.gbr']!)).toBe(6);
    expect(countGerberFlashes(gbr['hand-board-B_Cu.gbr']!)).toBe(5);
    expect(countGerberFlashes(gbr['hand-board-F_Mask.gbr']!)).toBe(5);
    expect(countGerberFlashes(gbr['hand-board-B_Mask.gbr']!)).toBe(4);

    // Track counts: 2 tracks on F_Cu, 2 tracks on B_Cu
    expect(countGerberMoves(gbr['hand-board-F_Cu.gbr']!)).toBe(2);
    expect(countGerberMoves(gbr['hand-board-B_Cu.gbr']!)).toBe(2);
  });

  it('generates METRIC Excellon PTH and NPTH drill files with tool tables and via drills', () => {
    const doc = makeRoutedDoc();
    const drl = excellon(doc.read, { pads: handPads });

    expect(Object.keys(drl).sort()).toEqual([
      'hand-board-NPTH.drl',
      'hand-board-PTH.drl',
    ]);

    const pth = drl['hand-board-PTH.drl']!;
    expect(pth).toContain('M48');
    expect(pth).toContain('METRIC,TZ');
    expect(pth).toContain('T1C0.3000'); // via drill 0.3 mm
    expect(pth).toContain('T2C1.0000'); // J1 TH drills 1.0 mm
    expect(pth).toContain('X19.0000Y10.0000');
    expect(pth).toContain('X5.0000Y6.0000');
    expect(pth).toContain('X5.0000Y8.5400');

    const npth = drl['hand-board-NPTH.drl']!;
    expect(npth).toContain('METRIC,TZ');
    expect(npth).toContain('T1C2.0000');
    expect(npth).toContain('X5.0000Y3.0000');
  });

  it('generates deterministic BOM and Pick-and-Place CSVs excluding non-PCB symbols', () => {
    const doc = makeRoutedDoc();
    const bomCsv = bom(doc.read);
    expect(bomCsv).toBe([
      'ref,value,footprint,qty',
      'D1,red,LED_D5.0mm,1',
      'J1,5V,Header_1x02_P2.54mm,1',
      '"R1,R2",330,0805,2',
      '',
    ].join('\n'));

    const pnpCsv = pickAndPlace(doc.read);
    expect(pnpCsv).toBe([
      'ref,value,footprint,x,y,rotation,side',
      'D1,red,LED_D5.0mm,22,10,90,bottom',
      'J1,5V,Header_1x02_P2.54mm,5,6,0,top',
      'R1,330,0805,14,10,45,top',
      'R2,330,0805,14,15,0,top',
      '',
    ].join('\n'));
  });

  it('bundles all 11 files deterministically in fabZip(q)', () => {
    const doc = makeRoutedDoc();
    const zip1 = fabZip(doc.read, { pads: handPads, footprints: handFootprints });
    const zip2 = fabZip(doc.read, { pads: handPads, footprints: handFootprints });
    expect(Buffer.from(zip1).equals(Buffer.from(zip2))).toBe(true);

    const unzipped = unzipSync(zip1);
    expect(Object.keys(unzipped).sort()).toEqual([
      'hand-board-B_Cu.gbr',
      'hand-board-B_Mask.gbr',
      'hand-board-B_Silkscreen.gbr',
      'hand-board-Edge_Cuts.gbr',
      'hand-board-F_Cu.gbr',
      'hand-board-F_Mask.gbr',
      'hand-board-F_Silkscreen.gbr',
      'hand-board-NPTH.drl',
      'hand-board-PTH.drl',
      'hand-board-bom.csv',
      'hand-board-pnp.csv',
    ]);
    expect(strFromU8(unzipped['hand-board-bom.csv']!)).toContain('"R1,R2",330,0805,2');
  });

  it('validates all layers with @tracespace/core and renders board SVG to PNG with @resvg/resvg-js', async () => {
    const doc = makeRoutedDoc();
    const gbr = gerbers(doc.read, { pads: handPads, footprints: handFootprints });
    const drl = excellon(doc.read, { pads: handPads });

    const dir = mkdtempSync(join(tmpdir(), 'cadllm-export-unit-'));
    try {
      const paths: string[] = [];
      for (const [name, content] of Object.entries({ ...gbr, ...drl }).sort(([a], [b]) => a.localeCompare(b))) {
        const p = join(dir, name);
        writeFileSync(p, content, 'utf8');
        paths.push(p);
      }

      const readRes = await read(paths);
      const plotted = plot(readRes);
      const rendered = renderLayers(plotted);
      const board = renderBoard(rendered);

      // Verify layer identification
      const layerMap = new Map(readRes.layers.map(l => [l.filename, l]));
      expect(layerMap.get('hand-board-F_Cu.gbr')?.type).toBe('copper');
      expect(layerMap.get('hand-board-F_Cu.gbr')?.side).toBe('top');
      expect(layerMap.get('hand-board-B_Cu.gbr')?.type).toBe('copper');
      expect(layerMap.get('hand-board-B_Cu.gbr')?.side).toBe('bottom');
      expect(layerMap.get('hand-board-F_Mask.gbr')?.type).toBe('soldermask');
      expect(layerMap.get('hand-board-B_Mask.gbr')?.type).toBe('soldermask');
      expect(layerMap.get('hand-board-F_Silkscreen.gbr')?.type).toBe('silkscreen');
      expect(layerMap.get('hand-board-B_Silkscreen.gbr')?.type).toBe('silkscreen');
      expect(layerMap.get('hand-board-Edge_Cuts.gbr')?.type).toBe('outline');
      expect(layerMap.get('hand-board-PTH.drl')?.type).toBe('drill');
      expect(layerMap.get('hand-board-NPTH.drl')?.type).toBe('drill');

      // Board extents match 30x20 mm outline
      expect(plotted.boardShape.regions.length).toBe(1);
      expect(plotted.boardShape.size).toEqual([0, 0, 30, 20]);

      // Plotted pad flash counts per layer
      const childrenOf = (name: string) => getPlotChildren(plotted, layerMap.get(name)!.id);
      const shapeCount = (name: string) => childrenOf(name).filter(c => c.type === 'imageShape').length;
      const segmentCount = (name: string) =>
        childrenOf(name)
          .filter(c => c.type === 'imagePath')
          .reduce((n, c) => n + (c.segments?.length ?? 0), 0);

      expect(shapeCount('hand-board-F_Cu.gbr')).toBe(6); // 5 F/TH pads + 1 via
      expect(shapeCount('hand-board-B_Cu.gbr')).toBe(5); // 4 B/TH pads + 1 via
      expect(shapeCount('hand-board-F_Mask.gbr')).toBe(5); // 5 F/TH pads
      expect(shapeCount('hand-board-B_Mask.gbr')).toBe(4); // 4 B/TH pads

      // Plotted track segment counts (F_Cu: 1 track w/ 2 segments + 1 track w/ 1 segment = 3; B_Cu: 2 tracks w/ 1 segment = 2)
      expect(segmentCount('hand-board-F_Cu.gbr')).toBe(3);
      expect(segmentCount('hand-board-B_Cu.gbr')).toBe(2);

      // Plotted drill hit counts (PTH: 2 TH pads + 1 via = 3; NPTH: 1 hole)
      expect(shapeCount('hand-board-PTH.drl')).toBe(3);
      expect(shapeCount('hand-board-NPTH.drl')).toBe(1);

      // Render board top and bottom SVGs to PNG with @resvg/resvg-js
      const topSvg = stringifySvg(board.top);
      const bottomSvg = stringifySvg(board.bottom);
      expect(topSvg).toContain('<svg');
      expect(bottomSvg).toContain('<svg');

      const topPng = new Resvg(topSvg, { fitTo: { mode: 'width', value: 800 } }).render().asPng();
      const bottomPng = new Resvg(bottomSvg, { fitTo: { mode: 'width', value: 800 } }).render().asPng();
      expect(topPng.byteLength).toBeGreaterThan(100);
      expect(bottomPng.byteLength).toBeGreaterThan(100);
      expect(Buffer.from(topPng.subarray(0, 8)).equals(PNG_MAGIC)).toBe(true);
      expect(Buffer.from(bottomPng.subarray(0, 8)).equals(PNG_MAGIC)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isPcbImplemented())('@cadllm/export end-to-end validation on example boards', () => {
  it('routes and exports examples/led-pcb.cnl and validates all layers with @tracespace/core + @resvg/resvg-js', async () => {
    const cnlPath = resolve(import.meta.dirname, '../../../examples/led-pcb.cnl');
    const doc = loadCircuit(readFileSync(cnlPath, 'utf8'), lib);

    const routed = route(doc.read);
    expect(routed.unrouted).toEqual([]);
    doc.transact(tx => {
      const pcb = tx.ensurePcb();
      pcb.tracks.push(...routed.tracks);
      pcb.vias.push(...routed.vias);
    });

    const q = doc.read;
    const allPads = pads(q);
    const tracks = q.circuit.pcb?.tracks ?? [];
    const vias = q.circuit.pcb?.vias ?? [];

    const expectedFShapes = allPads.filter(p => p.layers === 'TH' || p.layers === 'F').length + vias.length;
    const expectedBShapes = allPads.filter(p => p.layers === 'TH' || p.layers === 'B').length + vias.length;
    const expectedFMask = allPads.filter(p => p.layers === 'TH' || p.layers === 'F').length;
    const expectedBMask = allPads.filter(p => p.layers === 'TH' || p.layers === 'B').length;
    const expectedFTracks = tracks.filter(t => t.layer === 'F' && t.points.length >= 2);
    const expectedBTracks = tracks.filter(t => t.layer === 'B' && t.points.length >= 2);
    const expectedPthHits = allPads.filter(p => p.layers === 'TH' && (p.drill ?? 0) > 0).length + vias.length;
    const expectedNpthHits = allPads.filter(p => p.layers !== 'TH' && (p.drill ?? 0) > 0).length;

    const gbr = gerbers(q);
    const drl = excellon(q);

    expect(countGerberMoves(gbr['led-pcb-F_Cu.gbr']!)).toBe(expectedFTracks.length);
    expect(countGerberMoves(gbr['led-pcb-B_Cu.gbr']!)).toBe(expectedBTracks.length);

    const dir = mkdtempSync(join(tmpdir(), 'cadllm-led-pcb-'));
    try {
      const paths: string[] = [];
      for (const [name, content] of Object.entries({ ...gbr, ...drl }).sort(([a], [b]) => a.localeCompare(b))) {
        const p = join(dir, name);
        writeFileSync(p, content, 'utf8');
        paths.push(p);
      }

      const readRes = await read(paths);
      const plotted = plot(readRes);
      const rendered = renderLayers(plotted);
      const board = renderBoard(rendered);

      const layerMap = new Map(readRes.layers.map(l => [l.filename, l]));
      const childrenOf = (name: string) => getPlotChildren(plotted, layerMap.get(name)!.id);
      const shapeCount = (name: string) => childrenOf(name).filter(c => c.type === 'imageShape').length;
      const segmentCount = (name: string) =>
        childrenOf(name)
          .filter(c => c.type === 'imagePath')
          .reduce((n, c) => n + (c.segments?.length ?? 0), 0);

      expect(plotted.boardShape.regions.length).toBe(1);
      expect(plotted.boardShape.size).toEqual([0, 0, 30, 20]);

      expect(shapeCount('led-pcb-F_Cu.gbr')).toBe(expectedFShapes);
      expect(shapeCount('led-pcb-B_Cu.gbr')).toBe(expectedBShapes);
      expect(shapeCount('led-pcb-F_Mask.gbr')).toBe(expectedFMask);
      expect(shapeCount('led-pcb-B_Mask.gbr')).toBe(expectedBMask);

      expect(segmentCount('led-pcb-F_Cu.gbr')).toBe(
        expectedFTracks.reduce((n, t) => n + t.points.length - 1, 0),
      );
      expect(segmentCount('led-pcb-B_Cu.gbr')).toBe(
        expectedBTracks.reduce((n, t) => n + t.points.length - 1, 0),
      );

      expect(shapeCount('led-pcb-PTH.drl')).toBe(expectedPthHits);
      expect(shapeCount('led-pcb-NPTH.drl')).toBe(expectedNpthHits);

      const topPng = new Resvg(stringifySvg(board.top), { fitTo: { mode: 'width', value: 800 } }).render().asPng();
      expect(Buffer.from(topPng.subarray(0, 8)).equals(PNG_MAGIC)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-places, routes, and exports examples/nand-led.cnl and validates with @tracespace/core', async () => {
    const cnlPath = resolve(import.meta.dirname, '../../../examples/nand-led.cnl');
    const doc = loadCircuit(readFileSync(cnlPath, 'utf8'), lib);

    const placed = autoPlacePcb(doc.read);
    doc.transact(tx => {
      for (const [ref, pl] of Object.entries(placed.place)) {
        tx.updateComponent(ref, { place: { pcb: pl } });
      }
    });

    const routed = route(doc.read);
    expect(routed.unrouted).toEqual([]);
    doc.transact(tx => {
      const pcb = tx.ensurePcb();
      pcb.tracks.push(...routed.tracks);
      pcb.vias.push(...routed.vias);
    });

    const q = doc.read;
    const allPads = pads(q);
    const vias = q.circuit.pcb?.vias ?? [];
    const gbr = gerbers(q);
    const drl = excellon(q);

    const dir = mkdtempSync(join(tmpdir(), 'cadllm-nand-led-'));
    try {
      const paths: string[] = [];
      for (const [name, content] of Object.entries({ ...gbr, ...drl }).sort(([a], [b]) => a.localeCompare(b))) {
        const p = join(dir, name);
        writeFileSync(p, content, 'utf8');
        paths.push(p);
      }

      const readRes = await read(paths);
      const plotted = plot(readRes);
      const layerMap = new Map(readRes.layers.map(l => [l.filename, l]));
      const shapeCount = (name: string) =>
        getPlotChildren(plotted, layerMap.get(name)!.id).filter(c => c.type === 'imageShape').length;

      expect(plotted.boardShape.regions.length).toBe(1);
      expect(shapeCount('nand-led-F_Cu.gbr')).toBe(
        allPads.filter(p => p.layers === 'TH' || p.layers === 'F').length + vias.length,
      );
      expect(shapeCount('nand-led-B_Cu.gbr')).toBe(
        allPads.filter(p => p.layers === 'TH' || p.layers === 'B').length + vias.length,
      );
      expect(shapeCount('nand-led-PTH.drl')).toBe(
        allPads.filter(p => p.layers === 'TH' && (p.drill ?? 0) > 0).length + vias.length,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs fab-preview.ts on examples/led-pcb.cnl and writes zip, per-layer SVGs/PNGs, and combined preview PNG', async () => {
    const cnlPath = resolve(import.meta.dirname, '../../../examples/led-pcb.cnl');
    const outDir = mkdtempSync(join(tmpdir(), 'cadllm-fab-preview-'));
    try {
      const res = await generateFabPreview(cnlPath, outDir, { layerWidth: 360, boardWidth: 480 });
      expect(res.project).toBe('led-pcb');
      expect(existsSync(res.zipPath)).toBe(true);
      expect(res.layerSvgs.length).toBe(9);
      expect(res.layerPngs.length).toBe(9);
      expect(existsSync(res.topPngPath)).toBe(true);
      expect(existsSync(res.bottomPngPath)).toBe(true);
      expect(existsSync(res.combinedPngPath)).toBe(true);
      const previewBytes = readFileSync(res.combinedPngPath);
      expect(previewBytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
