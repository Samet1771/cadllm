// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { Doc, type PartDef, type PartResolver } from '@cadllm/core';
import { applyEdit, loadCircuit } from '@cadllm/dsl';
import { Engine } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import {
  autoPlacePcb,
  drc,
  pads,
  ratsnest,
  route,
  type Footprint,
  type PadInstance,
  type RouteResult,
} from '../src/index.ts';

const lib = loadLibrary([builtinPartsDir]);
const repoRoot = resolve(import.meta.dirname, '../../..');

function makeDoc(cnl: string, extraParts: PartDef[] = []): Doc {
  const resolver: PartResolver = {
    get: id => extraParts.find(p => p.id === id) ?? lib.get(id),
  };
  const doc = new Doc(resolver);
  doc.transact(tx => { applyEdit(tx, cnl); });
  return doc;
}

function applyRouteResult(doc: Doc, res: RouteResult, reroute = false, nets?: string[]): void {
  doc.transact(tx => {
    if (reroute) {
      if (nets?.length) for (const n of nets) tx.removePcbCopper(n);
      else tx.removePcbCopper();
    }
    const pcb = tx.ensurePcb();
    pcb.tracks.push(...res.tracks);
    pcb.vias.push(...res.vias);
  });
}

function testPad(
  doc: Doc,
  pinToken: string,
  at: [number, number],
  opts: Partial<Omit<PadInstance, 'at' | 'pinLabel'>> = {},
): PadInstance {
  const resolved = doc.read.resolvePin(pinToken);
  const net = doc.read.netOfPin(resolved.key);
  return {
    ref: resolved.comp.ref,
    compId: resolved.comp.id,
    pinId: resolved.pin.id,
    pinLabel: doc.read.pinLabel(resolved.key),
    ...(net ? { netId: net.id, net: net.name } : {}),
    shape: opts.shape ?? 'circle',
    at,
    size: opts.size ?? [1.4, 1.4],
    rot: opts.rot ?? 0,
    ...(opts.drill !== undefined ? { drill: opts.drill } : {}),
    layers: opts.layers ?? 'TH',
    ...(opts.roundRadius !== undefined ? { roundRadius: opts.roundRadius } : {}),
  };
}

describe('WP2 connectivity & ratsnest', () => {
  it('computes deterministic MST per net over pads and merges connected islands', () => {
    const doc = makeDoc(`
      R1 res 330 @pcb:5,5
      R2 res 330 @pcb:15,5
      R3 res 330 @pcb:15,15
      SIG: R1.1 R2.1 R3.1
      board 30x20
    `);
    const p1 = testPad(doc, 'R1.1', [5, 5], { layers: 'F', shape: 'rect', size: [1, 1] });
    const p2 = testPad(doc, 'R2.1', [15, 5], { layers: 'F', shape: 'rect', size: [1, 1] });
    const p3 = testPad(doc, 'R3.1', [15, 15], { layers: 'F', shape: 'rect', size: [1, 1] });
    const testPads = [p1, p2, p3];

    // All 3 pads separate -> 2 MST edges (R1.1-R2.1, R2.1-R3.1)
    const rn1 = ratsnest(doc.read, { pads: testPads });
    expect(rn1.count).toBe(2);
    expect(rn1.connections.map(c => `${c.fromPin}-${c.toPin}`)).toEqual(['R1.1-R2.1', 'R2.1-R3.1']);

    // Reverse pad order -> identical MST output
    expect(ratsnest(doc.read, { pads: [...testPads].reverse() })).toEqual(rn1);

    // Connect R1.1 and R2.1 with an F track -> 2 islands ({R1.1,R2.1,track}, {R3.1}), 1 edge
    doc.transact(tx => { tx.addTrack({ net: 'SIG', layer: 'F', width: 0.3, points: [[5, 5], [15, 5]] }); });
    const rn2 = ratsnest(doc.read, { pads: testPads });
    expect(rn2.count).toBe(1);
    expect(rn2.connections[0]!.net).toBe('SIG');
    expect(rn2.connections[0]!.toPin).toBe('R3.1');

    // Add a separate B track from midpoint (10,5) to (15,15) WITHOUT a via:
    // B track doesn't connect to F track at (10,5) or F-only pad p3 at (15,15) -> 3 islands (2 MST edges)
    doc.transact(tx => { tx.addTrack({ net: 'SIG', layer: 'B', width: 0.3, points: [[10, 5], [15, 15]] }); });
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(2);

    // Via at (10,5) merges F track + B track into 1 island, still missing F-pad p3 at (15,15) -> 1 edge
    doc.transact(tx => { tx.addVia({ net: 'SIG', at: [10, 5] }); });
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(1);

    // Via at (15,15) bridges B track to F pad p3 -> 1 island, 0 ratsnest!
    doc.transact(tx => { tx.addVia({ net: 'SIG', at: [15, 15] }); });
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
  });

  it('connects rotated roundrect/oval pads and TH pads bridging F/B layers', () => {
    const doc = makeDoc(`
      R1 res 1k @pcb:10,10
      R2 res 1k @pcb:20,10
      N1: R1.1 R2.1
      board 30x20
    `);
    const testPads = [
      testPad(doc, 'R1.1', [10, 10], { shape: 'roundrect', size: [3, 1], rot: 45, layers: 'F', roundRadius: 0.25 }),
      testPad(doc, 'R2.1', [20, 10], { shape: 'oval', size: [2, 1.4], rot: 90, layers: 'TH', drill: 0.8 }),
    ];
    doc.transact(tx => {
      tx.addTrack({ net: 'N1', layer: 'F', width: 0.25, points: [[10.8, 10.8], [15, 10]] });
      tx.addVia({ net: 'N1', at: [15, 10] });
      tx.addTrack({ net: 'N1', layer: 'B', width: 0.25, points: [[15, 10], [20, 10.5]] });
    });
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
  });

  it('merges multi-pad pins sharing the same (compId, pinId)', () => {
    const doc = makeDoc(`
      SW1 button @pcb:10,10
      R1  res 1k @pcb:20,10
      NETA: SW1.1 R1.1
      board 30x20
    `);
    const p1a = testPad(doc, 'SW1.1', [8, 8], { layers: 'TH', drill: 0.9 });
    const p1b = testPad(doc, 'SW1.1', [8, 12], { layers: 'TH', drill: 0.9 });
    const pr = testPad(doc, 'R1.1', [20, 10], { layers: 'TH', drill: 0.8 });
    doc.transact(tx => { tx.addTrack({ net: 'NETA', layer: 'F', width: 0.25, points: [[8, 8], [20, 10]] }); });
    expect(ratsnest(doc.read, { pads: [p1a, p1b, pr] }).count).toBe(0);
  });
});

describe('WP2 DRC rules', () => {
  it('detects unplaced, bad_place, off_board (courtyard & copper-to-edge), and overlap', () => {
    const smdFp: Footprint = {
      name: 'TEST-SMD',
      pads: [
        { id: '1', shape: 'rect', at: [-1, 0], size: [1, 1], layers: 'F' },
        { id: '2', shape: 'rect', at: [1, 0], size: [1, 1], layers: 'F' },
      ],
      silk: [],
      courtyard: [4, 2],
      origin: [0, 0],
    };
    const thFp: Footprint = {
      name: 'TEST-TH',
      pads: [
        { id: '1', shape: 'circle', at: [-1, 0], size: [1.4, 1.4], drill: 0.8, layers: 'TH' },
        { id: '2', shape: 'circle', at: [1, 0], size: [1.4, 1.4], drill: 0.8, layers: 'TH' },
      ],
      silk: [],
      courtyard: [4, 2],
      origin: [0, 0],
    };

    const doc = makeDoc(`
      R1 res 1k footprint=TEST-SMD @pcb:10,10
      R2 res 1k footprint=TEST-SMD @pcb:10,10 bottom
      R3 res 1k footprint=TEST-SMD
      R4 res 1k footprint=TEST-SMD @pcb:bad_coords
      R5 res 1k footprint=TEST-TH  @pcb:29,10
      board 30x20
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
    `);

    const fps: Record<string, Footprint> = { 'TEST-SMD': smdFp, 'TEST-TH': thFp };
    const testPads: PadInstance[] = [
      testPad(doc, 'R1.1', [9, 10], { shape: 'rect', size: [1, 1], layers: 'F' }),
      testPad(doc, 'R1.2', [11, 10], { shape: 'rect', size: [1, 1], layers: 'F' }),
      testPad(doc, 'R2.1', [11, 10], { shape: 'rect', size: [1, 1], layers: 'B' }),
      testPad(doc, 'R2.2', [9, 10], { shape: 'rect', size: [1, 1], layers: 'B' }),
      testPad(doc, 'R5.1', [28, 10], { shape: 'circle', size: [1.4, 1.4], drill: 0.8, layers: 'TH' }),
      testPad(doc, 'R5.2', [30, 10], { shape: 'circle', size: [1.4, 1.4], drill: 0.8, layers: 'TH' }),
    ];

    const issues = drc(doc.read, { pads: testPads, footprints: fps });
    expect(issues.some(i => i.code === 'unplaced' && i.level === 'warn' && i.at.includes('R3'))).toBe(true);
    expect(issues.some(i => i.code === 'bad_place' && i.level === 'error' && i.at.includes('R4'))).toBe(true);
    expect(issues.some(i => i.code === 'off_board' && i.level === 'error' && i.at.includes('R5'))).toBe(true);
    expect(issues.some(i => i.code === 'overlap')).toBe(false); // top vs bottom SMD do not collide

    doc.transact(tx => { tx.updateComponent('R2', { place: { pcb: '11,10 top' } }); });
    const issues2 = drc(doc.read, { pads: testPads, footprints: fps });
    expect(issues2.some(i => i.code === 'overlap' && i.at.includes('R1') && i.at.includes('R2'))).toBe(true);
  });

  it('detects copper-to-board-edge clearance violations for pads, tracks, and vias', () => {
    const doc = makeDoc(`
      R1 res 1k @pcb:5,5
      R2 res 1k @pcb:15,5
      N1: R1.1 R2.1
      board 20x10
      rules clearance=0.3 track=0.25 via=0.6 drill=0.3
      track N1 F 0.25 5,5 5,0.35 15,0.35 15,5
      via N1 10,0.5
    `);
    const testPads = [
      testPad(doc, 'R1.1', [5, 5], { size: [1.2, 1.2], layers: 'F' }),
      testPad(doc, 'R2.1', [15, 5], { size: [1.2, 1.2], layers: 'F' }),
    ];
    const issues = drc(doc.read, { pads: testPads }).filter(i => i.code === 'off_board');
    expect(issues).toHaveLength(2);
    expect(issues.every(i => /mm/.test(i.message))).toBe(true);
  });

  it('detects pad-pad, pad-track, track-track, via-* clearance violations and shorts (other nets only)', () => {
    const doc = makeDoc(`
      R1 res 1k @pcb:5,5
      R2 res 1k @pcb:5,15
      R3 res 1k @pcb:15,5
      R4 res 1k @pcb:15,15
      A: R1.1 R2.1
      B: R3.1 R4.1
      board 30x25
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
    `);
    const testPads = [
      testPad(doc, 'R1.1', [5, 5], { size: [1.0, 1.0], layers: 'F' }),
      testPad(doc, 'R2.1', [5, 15], { size: [1.0, 1.0], layers: 'F' }),
      testPad(doc, 'R3.1', [6.1, 5], { size: [1.0, 1.0], layers: 'F' }), // pad-pad gap 0.1 < 0.2
      testPad(doc, 'R4.1', [15, 15], { size: [1.0, 1.0], layers: 'F' }),
    ];

    doc.transact(tx => {
      tx.addTrack({ net: 'A', layer: 'F', width: 0.25, points: [[5, 5], [5, 15]] });
      tx.addTrack({ net: 'B', layer: 'F', width: 0.25, points: [[6.1, 5], [5.35, 8], [5.35, 15], [15, 15]] });
      tx.addVia({ net: 'B', at: [5.5, 10] });
    });

    const issues = drc(doc.read, { pads: testPads });
    const shorts = issues.filter(i => i.code === 'short');
    const clearances = issues.filter(i => i.code === 'clearance');
    expect(shorts.some(s => s.at.includes('A') && s.at.includes('B') && s.at.includes('R2.1'))).toBe(true);
    expect(clearances.some(c => c.message.includes('R1.1') && c.message.includes('R3.1'))).toBe(true);
    expect(clearances.some(c => c.message.includes('via B') && c.message.includes('track A'))).toBe(true);
    expect(clearances.some(c => c.message.includes('track A') && c.message.includes('track B'))).toBe(true);
  });

  it('catches track_width, drill (pad & via), and unrouted counts, and ignores opposite-layer/same-net copper', () => {
    const doc = makeDoc(`
      R1 res 1k @pcb:5,5
      R2 res 1k @pcb:15,5
      R3 res 1k @pcb:5,15
      R4 res 1k @pcb:15,15
      A: R1.1 R2.1
      B: R3.1 R4.1
      board 25x25
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
      track A F 0.25 5,5 15,5
      track B B 0.25 5,15 15,15
      track A F 0.15 5,5 5,8
      via A 10,5 size=0.6 drill=0.2
      via B 10,15 size=0.5 drill=0.5
    `);
    const testPads = [
      testPad(doc, 'R1.1', [5, 5], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R2.1', [15, 5], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R3.1', [5, 15], { layers: 'B', size: [1.0, 1.0] }),
      testPad(doc, 'R4.1', [15, 15], { layers: 'TH', size: [1.0, 1.0], drill: 0.2 }),
    ];
    const issues = drc(doc.read, { pads: testPads });
    expect(issues.filter(i => i.code === 'short')).toEqual([]);
    expect(issues.filter(i => i.code === 'clearance')).toEqual([]);
    expect(issues.filter(i => i.code === 'track_width')).toHaveLength(1);
    expect(issues.filter(i => i.code === 'drill')).toHaveLength(3); // R4.1 pad drill + 2 vias
    expect(issues.filter(i => i.code === 'unrouted')).toEqual([]);

    doc.transact(tx => { tx.removePcbCopper('B'); });
    const unrouted = drc(doc.read, { pads: testPads }).filter(i => i.code === 'unrouted');
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]!.message).toMatch(/B/);
    expect(unrouted[0]!.message).toMatch(/R3\.1/);
    expect(unrouted[0]!.message).toMatch(/mm/);
  });
});

describe('WP2 autorouter', () => {
  it('routes crossing nets using F/B layers + vias with 0 DRC errors and simplified points', () => {
    const doc = makeDoc(`
      J1 dc_supply @pcb:5,5
      J2 dc_supply @pcb:20,15
      R1 res 1k @pcb:5,15
      R2 res 1k @pcb:20,5
      N1: J1.+ J2.+
      N2: R1.1 R2.1
      board 25x20
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
    `);
    const testPads = [
      testPad(doc, 'J1.+', [5, 5], { layers: 'F', shape: 'rect', size: [1.4, 1.4] }),
      testPad(doc, 'J2.+', [20, 15], { layers: 'F', shape: 'rect', size: [1.4, 1.4] }),
      testPad(doc, 'R1.1', [5, 15], { layers: 'F', shape: 'rect', size: [1.4, 1.4] }),
      testPad(doc, 'R2.1', [20, 5], { layers: 'F', shape: 'rect', size: [1.4, 1.4] }),
    ];

    const res = route(doc.read, { pads: testPads });
    expect(res.unrouted).toEqual([]);
    expect(res.vias.length).toBeGreaterThanOrEqual(2);
    for (const t of res.tracks) expect(t.points.length).toBeLessThanOrEqual(10);

    applyRouteResult(doc, res);
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
    expect(drc(doc.read, { pads: testPads }).filter(i => i.level === 'error')).toEqual([]);
  });

  it('keeps existing tracks as obstacles, extends partial nets, and supports opts.reroute', () => {
    const doc = makeDoc(`
      R1 res 1k @pcb:4,10
      R2 res 1k @pcb:20,10
      R3 res 1k @pcb:12,16
      R4 res 1k @pcb:12,4
      BLOCK: R4.1 R4.2
      SIG: R1.1 R2.1 R3.1
      board 25x20
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
      track BLOCK F 0.4 12,4 12,12
      track SIG F 0.25 4,10 8,10
    `);
    const testPads = [
      testPad(doc, 'R1.1', [4, 10], { layers: 'TH', drill: 0.8 }),
      testPad(doc, 'R2.1', [20, 10], { layers: 'TH', drill: 0.8 }),
      testPad(doc, 'R3.1', [12, 16], { layers: 'TH', drill: 0.8 }),
      testPad(doc, 'R4.1', [12, 4], { layers: 'TH', drill: 0.8 }),
      testPad(doc, 'R4.2', [12, 12], { layers: 'TH', drill: 0.8 }),
    ];

    const res = route(doc.read, { nets: ['SIG'], pads: testPads });
    expect(res.unrouted).toEqual([]);
    const sigId = doc.read.requireNet('SIG').id;
    expect(res.tracks.every(t => t.net === sigId)).toBe(true);

    applyRouteResult(doc, res);
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
    expect(drc(doc.read, { pads: testPads }).filter(i => i.level === 'error')).toEqual([]);

    // Reroute SIG from scratch while preserving BLOCK
    const rerouted = route(doc.read, { nets: ['SIG'], reroute: true, pads: testPads });
    expect(rerouted.unrouted).toEqual([]);
    applyRouteResult(doc, rerouted, true, ['SIG']);
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
    expect(drc(doc.read, { pads: testPads }).filter(i => i.level === 'error')).toEqual([]);
  });

  it('triggers rip-up-and-retry when an earlier net seals off a pad escape corridor', () => {
    // R3.1 (10,11) is trapped in an F+B copper pocket open ONLY through a 1-track corridor at (10,8).
    // A_SHORT (8.25,7)->(11.75,7) routes first directly across the corridor entrance unless ripped up;
    // B_ESCAPE then forces rip-up, exits through (10,8), and A_SHORT detours around via B/top!
    const doc = makeDoc(`
      R1 res 1k @pcb:5,5
      R2 res 1k @pcb:15,5
      R3 res 1k @pcb:10,11
      R4 res 1k @pcb:10,2
      R5 res 1k @pcb:8,7
      R6 res 1k @pcb:12,7
      A_SHORT: R5.1 R6.1
      B_ESCAPE: R3.1 R4.1
      WALL: R1.1 R2.1
      board 20x20
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
      track WALL F 0.4 9.0,8 6,8 6,15 14,15 14,8 11.0,8
      track WALL B 1.6 7.5,9 12.5,9
      track WALL B 1.6 7.5,10.5 12.5,10.5
      track WALL B 1.6 7.5,12 12.5,12
      track WALL B 1.6 7.5,13.5 12.5,13.5
    `);
    const testPads = [
      testPad(doc, 'R1.1', [6, 8], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R2.1', [14, 8], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R3.1', [10, 11], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R4.1', [10, 2], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R5.1', [8.25, 7], { layers: 'F', size: [1.0, 1.0] }),
      testPad(doc, 'R6.1', [11.75, 7], { layers: 'F', size: [1.0, 1.0] }),
    ];

    const res = route(doc.read, { pads: testPads });
    expect(res.unrouted).toEqual([]);
    expect(res.notes.some(n => /rip-up rounds:/.test(n))).toBe(true);
    applyRouteResult(doc, res);
    expect(ratsnest(doc.read, { pads: testPads }).count).toBe(0);
    expect(drc(doc.read, { pads: testPads }).filter(i => i.level === 'error')).toEqual([]);
  });

  it('routes dense SMD components (SOIC-14 + 0805 + SOT-23, top and bottom) cleanly', () => {
    const doc = makeDoc(`
      U1 74hc00 footprint=SOIC-14 @pcb:15,12
      R1 res 330 footprint=0805 @pcb:24,10
      R2 res 10k footprint=0805 @pcb:24,14 bottom
      D1 led red footprint=0805 @pcb:24,18
      VCC: U1.VCC R1.1
      GND: U1.GND R2.2 D1.K
      OUT: U1.1Y R1.2 R2.1 D1.A
      board 35x25
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
    `);

    const res = route(doc.read);
    expect(res.unrouted).toEqual([]);
    applyRouteResult(doc, res);
    expect(ratsnest(doc.read).count).toBe(0);
    expect(drc(doc.read).filter(i => i.level === 'error')).toEqual([]);
  });

  it('autoroutes examples/led-pcb.cnl (as-is and auto-placed) in < 3s deterministically', () => {
    const cnl = readFileSync(resolve(repoRoot, 'examples/led-pcb.cnl'), 'utf8');

    // 1. Raw examples/led-pcb.cnl routes all nets with 0 unrouted and 0 copper errors
    const raw1 = loadCircuit(cnl, lib);
    const raw2 = loadCircuit(cnl, lib);
    expect(pads(raw1.read).length).toBe(8);
    expect(ratsnest(raw1.read).count).toBe(5);

    const tRaw = performance.now();
    const resRaw1 = route(raw1.read);
    const rawMs = performance.now() - tRaw;
    expect(resRaw1).toEqual(route(raw2.read));
    expect(resRaw1.unrouted).toEqual([]);
    expect(rawMs).toBeLessThan(3000);
    applyRouteResult(raw1, resRaw1);
    expect(ratsnest(raw1.read).count).toBe(0);
    // Note: raw led-pcb.cnl hand-placed R1@14,10 and D1@22,10 overlap courtyards under THT-axial+LED_D5.0mm;
    // verify zero copper/electrical DRC errors (short, clearance, off_board, track_width, drill, unrouted).
    const copperErrs = drc(raw1.read).filter(i => i.level === 'error' && i.code !== 'overlap');
    expect(copperErrs).toEqual([]);

    // 2. Re-placed with autoPlacePcb -> 0 DRC errors of ANY kind and 0 unrouted
    const doc = loadCircuit(cnl, lib);
    const placed = autoPlacePcb(doc.read, { all: true });
    doc.transact(tx => {
      for (const [ref, pos] of Object.entries(placed.place)) tx.updateComponent(ref, { place: { pcb: pos } });
    });
    const tPlaced = performance.now();
    const resPlaced = route(doc.read);
    const placedMs = performance.now() - tPlaced;
    expect(resPlaced.unrouted).toEqual([]);
    expect(placedMs).toBeLessThan(3000);
    applyRouteResult(doc, resPlaced);
    const issues = drc(doc.read);
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    expect(issues.filter(i => i.code === 'unrouted')).toEqual([]);
  });

  it('autoroutes examples/nand-led.cnl (board 40x30 + autoPlacePcb) with 0 DRC errors, 0 unrouted, < 3s, deterministic', () => {
    const cnl = readFileSync(resolve(repoRoot, 'examples/nand-led.cnl'), 'utf8');

    // Note: BatteryHolder_9V is 54x30 mm so it cannot fit inside 40x30 without WireLeads;
    // test both WireLeads on 40x30 AND unmodified nand-led.cnl with auto-sized board.
    const doc = loadCircuit(cnl, lib);
    doc.transact(tx => {
      tx.updateComponent('BAT1', { props: { footprint: 'WireLeads' } });
      tx.setBoard([[0, 0], [40, 0], [40, 30], [0, 30]]);
    });
    const placed = autoPlacePcb(doc.read);
    doc.transact(tx => {
      for (const [ref, pos] of Object.entries(placed.place)) tx.updateComponent(ref, { place: { pcb: pos } });
    });

    const t0 = performance.now();
    const res1 = route(doc.read);
    const elapsedMs = performance.now() - t0;

    expect(res1).toEqual(route(doc.read));
    expect(res1.unrouted).toEqual([]);
    expect(elapsedMs).toBeLessThan(3000);

    applyRouteResult(doc, res1);
    expect(ratsnest(doc.read).count).toBe(0);
    const issues = drc(doc.read);
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    expect(issues.filter(i => i.code === 'unrouted')).toEqual([]);

    // Also verify unmodified nand-led.cnl (BatteryHolder_9V) + autoPlacePcb routes with 0 DRC errors
    const docUnmod = loadCircuit(cnl, lib);
    const placedUnmod = autoPlacePcb(docUnmod.read);
    docUnmod.transact(tx => {
      for (const [ref, pos] of Object.entries(placedUnmod.place)) tx.updateComponent(ref, { place: { pcb: pos } });
    });
    const tUnmod = performance.now();
    const resUnmod = route(docUnmod.read);
    expect(performance.now() - tUnmod).toBeLessThan(3000);
    expect(resUnmod.unrouted).toEqual([]);
    applyRouteResult(docUnmod, resUnmod);
    const issuesUnmod = drc(docUnmod.read);
    expect(issuesUnmod.filter(i => i.level === 'error')).toEqual([]);
    expect(issuesUnmod.filter(i => i.code === 'unrouted')).toEqual([]);
  });

  it('routes without explicit board outline and reports truly boxed-in nets as unrouted', () => {
    const doc = makeDoc(`
      R1 res 1k footprint=0805 @pcb:10,10
      R2 res 1k footprint=0805 @pcb:20,10
      N1: R1.1 R2.1
    `);
    const res = route(doc.read);
    expect(res.unrouted).toEqual([]);
    applyRouteResult(doc, res);
    expect(ratsnest(doc.read).count).toBe(0);

    // Box in a pad on both F and B completely with a foreign wall so it is genuinely unroutable
    const blocked = makeDoc(`
      R1 res 1k @pcb:10,10
      R2 res 1k @pcb:10,2
      R3 res 1k @pcb:5,5
      R4 res 1k @pcb:15,5
      N1: R1.1 R2.1
      WALL: R3.1 R4.1
      board 20x20
      rules clearance=0.2 track=0.25 via=0.6 drill=0.3
      track WALL F 0.4 7,7 13,7 13,13 7,13 7,7
      track WALL B 0.4 7,7 13,7 13,13 7,13 7,7
    `);
    const p = [
      testPad(blocked, 'R1.1', [10, 10], { layers: 'F', size: [1.0, 1.0] }),
      testPad(blocked, 'R2.1', [10, 2], { layers: 'F', size: [1.0, 1.0] }),
      testPad(blocked, 'R3.1', [7, 7], { layers: 'F', size: [1.0, 1.0] }),
      testPad(blocked, 'R4.1', [13, 7], { layers: 'F', size: [1.0, 1.0] }),
    ];
    const rBlocked = route(blocked.read, { pads: p });
    expect(rBlocked.unrouted).toEqual(['N1']);
  });

  it('integrates cleanly with Engine edit issueTail, layout op=route, check, and undo', () => {
    const e = new Engine({ library: lib, root: repoRoot });
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    const tail = e.edit({ cnl: '~BAT1 footprint=WireLeads\nboard 40x30' });
    expect(tail).not.toContain('pcb check pending');
    expect(tail).toContain('unplaced in PCB');

    e.layout({ view: 'pcb' });
    expect(e.layout({ view: 'pcb', op: 'route' })).toMatch(/^ok rev=\d+ routed \d+ tracks, \d+ vias/);
    const checked = e.check();
    expect(checked).toMatch(/^nand-led rev=\d+ 0 err /);
    expect(checked).not.toContain('unrouted');

    // Undo routing restores unrouted warnings
    e.history({ op: 'undo' });
    expect(e.check()).toContain('unrouted');
  });
});
