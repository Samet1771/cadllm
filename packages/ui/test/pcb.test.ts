// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { Query, type Circuit, type PartDef, type PartResolver } from '@cadllm/core';
import type { PadInstance } from '@cadllm/pcb';
import {
  boundsForDrcTargets,
  flipPcbPlace,
  hitTestPads,
  hitTestTrack,
  hitTestVia,
  movePcbPlace,
  padLabel,
  rotatePcbPlace,
  snapMm,
  snapPointMm,
  trackWidthFromRules,
  viaSpecFromRules,
} from '../src/lib/pcb.ts';
import {
  addRouteBend,
  buildPcbPlaceEdit,
  buildRemoveTracksCnl,
  buildTrackEditLine,
  buildViaEditLine,
  collapseCollinear,
  finishPcbRoute,
  insertRouteVia,
  previewRoutePaths,
  route45Elbow,
  snapAngle45,
  startPcbRoute,
  updateRouteCursor,
} from '../src/lib/pcbRoute.ts';
import { checkPcbDrc, renderPcbWithFallback, resolvePcbPads } from '../src/lib/pcbFallback.ts';
import { createDemoBackend } from '../src/lib/demo.ts';

const PARTS: Record<string, PartDef> = {
  res: {
    id: 'res',
    name: 'Resistor',
    summary: 'resistor',
    category: 'passive',
    refPrefix: 'R',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    footprints: ['0805', 'THT-axial'],
  },
  led: {
    id: 'led',
    name: 'LED',
    summary: 'led',
    category: 'io',
    refPrefix: 'D',
    pins: [
      { id: '1', name: 'A', type: 'passive' },
      { id: '2', name: 'K', type: 'passive' },
    ],
    footprints: ['LED_D5.0mm'],
  },
};

const resolver: PartResolver = { get: id => PARTS[id] };

function makeCircuit(): Circuit {
  return {
    meta: {},
    seq: 4,
    components: {
      c1: { id: 'c1', ref: 'R1', part: 'res', props: { resistance: '330' }, place: { pcb: '10,10' } },
      c2: { id: 'c2', ref: 'D1', part: 'led', props: { color: 'red' }, place: { pcb: '20,10' } },
    },
    nets: {
      n1: { id: 'n1', name: 'LA', pins: ['c1:2', 'c2:1'] },
      n2: { id: 'n2', name: 'VCC', pins: ['c1:1'] },
    },
    pcb: {
      board: { outline: [[0, 0], [30, 0], [30, 20], [0, 20]] },
      rules: { clearance: 0.2, track: 0.35, via: 0.7, drill: 0.35 },
      tracks: [
        { net: 'n1', layer: 'F', width: 0.35, points: [[15, 10], [18, 10], [18, 12]] },
        { net: 'n2', layer: 'B', width: 0.4, points: [[5, 5], [5, 12]] },
      ],
      vias: [
        { net: 'n1', at: [18, 12], size: 0.7, drill: 0.35 },
      ],
    },
  };
}

const SAMPLE_PADS: PadInstance[] = [
  {
    ref: 'R1',
    compId: 'c1',
    pinId: '1',
    pinLabel: '1',
    netId: 'n2',
    net: 'VCC',
    shape: 'rect',
    at: [9.05, 10],
    size: [1.0, 1.3],
    rot: 0,
    layers: 'F',
  },
  {
    ref: 'R1',
    compId: 'c1',
    pinId: '2',
    pinLabel: '2',
    netId: 'n1',
    net: 'LA',
    shape: 'rect',
    at: [10.95, 10],
    size: [1.0, 1.3],
    rot: 0,
    layers: 'F',
  },
  {
    ref: 'D1',
    compId: 'c2',
    pinId: '1',
    pinLabel: 'A',
    netId: 'n1',
    net: 'LA',
    shape: 'circle',
    at: [18.73, 10],
    size: [1.6, 1.6],
    rot: 0,
    drill: 0.8,
    layers: 'TH',
  },
  {
    ref: 'D1',
    compId: 'c2',
    pinId: '2',
    pinLabel: 'K',
    shape: 'circle',
    at: [21.27, 10],
    size: [1.6, 1.6],
    rot: 0,
    drill: 0.8,
    layers: 'TH',
  },
  {
    ref: 'U2',
    compId: 'c3',
    pinId: '1',
    pinLabel: '1',
    netId: 'n1',
    net: 'LA',
    shape: 'oval',
    at: [15, 16],
    size: [2.0, 1.0],
    rot: 90,
    layers: 'B',
  },
];

describe('pcb snapping and placement helpers', () => {
  it('snaps scalars and points to 0.5 mm grid', () => {
    expect(snapMm(12.24)).toBe(12);
    expect(snapMm(12.26)).toBe(12.5);
    expect(snapMm(-0.1)).toBe(0);
    expect(snapPointMm([3.74, 8.76])).toEqual([3.5, 9]);
  });

  it('moves, rotates, and flips PCB placements canonically', () => {
    expect(movePcbPlace('10,10,90', 1.24, -0.76, [0, 0])).toBe('11,9,90');
    expect(movePcbPlace(undefined, 1, 2, [4.26, 7.74])).toBe('4.5,7.5');

    expect(rotatePcbPlace('10,10')).toBe('10,10,90');
    expect(rotatePcbPlace('10,10,270 bottom')).toBe('10,10 bottom');
    expect(flipPcbPlace('10,10,90')).toBe('10,10,90 bottom');
    expect(flipPcbPlace('10,10,90 bottom')).toBe('10,10,90');
  });

  it('reads track width and via size/drill from circuit rules', () => {
    const q = new Query(makeCircuit(), resolver);
    expect(trackWidthFromRules(q)).toBe(0.35);
    expect(viaSpecFromRules(q)).toEqual({ size: 0.7, drill: 0.35 });
  });
});

describe('pcb hit-testing helpers', () => {
  it('hit-tests pads with shape, rotation, and layer filtering', () => {
    expect(hitTestPads(SAMPLE_PADS, [9.1, 10.1])?.pinLabel).toBe('1');
    expect(hitTestPads(SAMPLE_PADS, [18.9, 10.2])?.pinLabel).toBe('A');

    // Rotated oval pad on B layer (width 2.0 rotated 90° -> vertical span +-1.0)
    expect(hitTestPads(SAMPLE_PADS, [15, 16.9], { layer: 'F' })).toBeUndefined();
    expect(hitTestPads(SAMPLE_PADS, [15, 16.9], { layer: 'B' })?.ref).toBe('U2');
    // TH pad matches both F and B
    expect(hitTestPads(SAMPLE_PADS, [18.73, 10], { layer: 'B' })?.pinLabel).toBe('A');
  });

  it('hit-tests tracks and vias respecting visible layers', () => {
    const q = new Query(makeCircuit(), resolver);
    const tracks = q.circuit.pcb!.tracks;
    const vias = q.circuit.pcb!.vias;

    const hitF = hitTestTrack(tracks, q, [16.5, 10.1], new Set(['F', 'B']));
    expect(hitF?.netName).toBe('LA');
    expect(hitF?.track.layer).toBe('F');

    // Hidden layer should not hit
    expect(hitTestTrack(tracks, q, [5, 8], new Set(['F']))).toBeUndefined();
    expect(hitTestTrack(tracks, q, [5, 8], new Set(['B']))?.netName).toBe('VCC');

    expect(hitTestVia(vias, q, [18.1, 12.1])?.netName).toBe('LA');
    expect(hitTestVia(vias, q, [25, 15])).toBeUndefined();
  });

  it('computes DRC target bounds from refs, pins, and net names', () => {
    const q = new Query(makeCircuit(), resolver);
    const box = boundsForDrcTargets(q, SAMPLE_PADS, ['R1.2', 'D1.A']);
    expect(box).toBeDefined();
    expect(box!.minX).toBeLessThan(10.95);
    expect(box!.maxX).toBeGreaterThan(18.73);
  });
});

describe('pcb 45/90 snapping and interactive routing state machine', () => {
  it('snaps cursor rays to 45°/90° angles and computes 45° elbows', () => {
    // Almost horizontal -> horizontal
    expect(snapAngle45([10, 10], [16.2, 10.4], 0.5)).toEqual([16, 10]);
    // Almost vertical -> vertical
    expect(snapAngle45([10, 10], [10.2, 15.8], 0.5)).toEqual([10, 16]);
    // 45° diagonal SE
    expect(snapAngle45([10, 10], [14.1, 13.9], 0.5)).toEqual([14, 14]);

    expect(route45Elbow([0, 0], [10, 4])).toEqual([[0, 0], [6, 0], [10, 4]]);
    expect(route45Elbow([0, 0], [4, 10])).toEqual([[0, 0], [0, 6], [4, 10]]);
    expect(route45Elbow([0, 0], [5, 5])).toEqual([[0, 0], [5, 5]]);

    expect(collapseCollinear([[0, 0], [2, 0], [5, 0], [5, 3]])).toEqual([[0, 0], [5, 0], [5, 3]]);
  });

  it('routes pad -> bends -> via -> target pad and builds track/via edit lines', () => {
    const rules = { clearance: 0.2, track: 0.3, via: 0.6, drill: 0.3 };

    // Unconnected pad fails cleanly
    const unconnected = startPcbRoute(SAMPLE_PADS[3]!, 'F', rules);
    expect(unconnected.ok).toBe(false);

    // Start from R1.2 (LA, layer F)
    const started = startPcbRoute(SAMPLE_PADS[1]!, 'F', rules);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let st = started.state;
    st = updateRouteCursor(st, [14, 10]);
    st = addRouteBend(st, [14, 10], 0.5);
    st = updateRouteCursor(st, [14, 13]);
    st = insertRouteVia(st, undefined, 0.5);
    expect(st.activeLayer).toBe('B');
    expect(st.vias).toEqual([[14, 13]]);

    // Cannot finish on wrong net (R1.1 = VCC)
    const wrongNet = finishPcbRoute(st, SAMPLE_PADS[0]!);
    expect(wrongNet.ok).toBe(false);

    // Finish on U2.1 (LA, layer B)
    const done = finishPcbRoute(st, SAMPLE_PADS[4]!);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.trackCount).toBe(2);
    expect(done.viaCount).toBe(1);
    expect(done.editCnl).toBe(
      [
        'track LA F 0.3 10.95,10 14,10 14,13',
        'track LA B 0.3 14,13 14,15 15,16',
        'via LA 14,13',
      ].join('\n'),
    );
  });

  it('rejects finishing on an F-only pad while routing on B without a via', () => {
    const rules = { clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 };
    const started = startPcbRoute(SAMPLE_PADS[4]!, 'F', rules); // B-only pad auto-starts on B
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.state.activeLayer).toBe('B');

    const res = finishPcbRoute(started.state, SAMPLE_PADS[1]!); // F-only pad
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/press V/i);
  });

  it('formats preview paths and CNL edit lines', () => {
    const rules = { clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 };
    const started = startPcbRoute(SAMPLE_PADS[1]!, 'F', rules);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const st = updateRouteCursor(started.state, [18.5, 10.1], SAMPLE_PADS[2]);
    const preview = previewRoutePaths(st);
    expect(preview.snappedToPad).toBe(true);
    expect(preview.activePreview).toEqual([[10.95, 10], [18.73, 10]]);

    expect(buildTrackEditLine('VCC', 'F', 0.4, [[10, 10], [20, 10]])).toBe('track VCC F 0.4 10,10 20,10');
    expect(buildViaEditLine('VCC', [20, 10])).toBe('via VCC 20,10');
    expect(buildViaEditLine('VCC', [20, 10], { size: 0.8, drill: 0.4, rules })).toBe('via VCC 20,10 size=0.8 drill=0.4');
    expect(buildRemoveTracksCnl('VCC')).toBe('-tracks VCC');
    expect(buildPcbPlaceEdit('R1', '12.5,8,90 bottom')).toBe('R1 @pcb:12.5,8,90 bottom');

    expect(padLabel({ ...SAMPLE_PADS[0]!, pinLabel: '1' })).toBe('R1.1');
    expect(padLabel({ ...SAMPLE_PADS[0]!, pinLabel: 'R1.1' })).toBe('R1.1');
  });

  it('uses real @cadllm/pcb render/pads/check when WP1 is implemented', () => {
    const q = new Query(makeCircuit(), resolver);
    const padList = resolvePcbPads(q, false);
    expect(padList.length).toBe(4);
    expect(padList.map(p => padLabel(p)).sort()).toEqual(['D1.A', 'D1.K', 'R1.1', 'R1.2']);

    const rendered = renderPcbWithFallback(q, { layers: ['F', 'B', 'silk', 'outline', 'ratsnest'] }, false);
    expect(rendered.isFallback).toBe(false);
    expect(rendered.svg).toContain('data-view="pcb"');
    expect(rendered.svg).toContain('data-ref="R1"');
    expect(rendered.svg).toContain('data-net="LA"');

    const drc = checkPcbDrc(q, false);
    expect(Array.isArray(drc.issues)).toBe(true);
  });

  it('demo backend supports led-pcb project, PCB edits, autoroute, check, and fab export', async () => {
    const demo = createDemoBackend();
    await demo.call('project', { op: 'use', name: 'led-pcb' });
    const st = await demo.state();
    const partsMap = new Map(Object.entries(st.parts));
    const q = new Query(st.circuit, { get: id => partsMap.get(id) });

    const rendered = renderPcbWithFallback(q, { layers: ['F', 'B', 'silk', 'outline', 'ratsnest'] }, true);
    expect(rendered.isFallback).toBe(false);
    expect(rendered.svg).toContain('data-view="pcb"');

    const padsList = resolvePcbPads(q, true);
    expect(padsList.length).toBe(6);

    const checkRes = await demo.call<string>('check', {});
    expect(checkRes).toContain('led-pcb');

    const routeRes = await demo.call<string>('layout', { view: 'pcb', op: 'route' });
    expect(routeRes).toContain('routed');

    const expRes = await demo.call<string>('export', { format: 'fab' });
    expect(expRes).toContain('led-pcb-fab.zip');
  });
});
