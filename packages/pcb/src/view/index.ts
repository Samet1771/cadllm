// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Component, type PartDef, type Query } from '@cadllm/core';
import { ratsnest } from '../connect/index.ts';
import { drc } from '../drc/index.ts';
import { componentFootprintName, footprint, isPcbPart } from '../footprints/index.ts';
import { autoPlacePcb, pads, parsePcbPlace } from '../place/index.ts';
import { compCourtyardCorners, polyBounds } from '../place/geometry.ts';
import type {
  Connection,
  DrcIssue,
  Footprint,
  PadInstance,
  PcbPlace,
  PcbRenderLayer,
  PcbRenderOptions,
  PcbTrack,
  PcbVia,
  PcbView,
  Point,
  SilkShape,
} from '../types.ts';
import { el, num, path, svgDoc, UNIT } from './svg.ts';
import { pcbStyle } from './theme.ts';

const DEFAULT_LAYERS: PcbRenderLayer[] = ['F', 'B', 'silk', 'outline', 'ratsnest'];

function renderSilkShape(s: SilkShape, cls: string): string {
  const sw = s.width !== undefined ? s.width * UNIT : undefined;
  const extra = sw !== undefined ? { style: `stroke-width:${num(sw)}` } : {};
  switch (s.kind) {
    case 'line':
      return el('line', {
        x1: s.from[0] * UNIT,
        y1: s.from[1] * UNIT,
        x2: s.to[0] * UNIT,
        y2: s.to[1] * UNIT,
        class: cls,
        ...extra,
      });
    case 'rect':
      return el('rect', {
        x: (s.at[0] - s.size[0] / 2) * UNIT,
        y: (s.at[1] - s.size[1] / 2) * UNIT,
        width: s.size[0] * UNIT,
        height: s.size[1] * UNIT,
        class: cls,
        ...extra,
      });
    case 'circle':
      return el('circle', {
        cx: s.at[0] * UNIT,
        cy: s.at[1] * UNIT,
        r: s.r * UNIT,
        class: cls,
        ...extra,
      });
    case 'arc': {
      const r = s.r * UNIT;
      const sRad = (s.startDeg * Math.PI) / 180;
      const eRad = (s.endDeg * Math.PI) / 180;
      const x1 = s.at[0] * UNIT + r * Math.cos(sRad);
      const y1 = s.at[1] * UNIT + r * Math.sin(sRad);
      const x2 = s.at[0] * UNIT + r * Math.cos(eRad);
      const y2 = s.at[1] * UNIT + r * Math.sin(eRad);
      const delta = s.endDeg - s.startDeg;
      const largeArc = Math.abs(delta) > 180 ? 1 : 0;
      const sweep = delta >= 0 ? 1 : 0;
      return el('path', {
        d: path(['M', x1, y1, 'A', r, r, 0, largeArc, sweep, x2, y2]),
        class: cls,
        ...extra,
      });
    }
    case 'poly': {
      if (s.points.length === 0) return '';
      const pts = s.points.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' ');
      return el(s.closed ? 'polygon' : 'polyline', { points: pts, class: cls, ...extra });
    }
  }
}

function renderPadShape(p: PadInstance, expandMm: number, cls: string, pinAttr?: string): string {
  const cx = p.at[0] * UNIT;
  const cy = p.at[1] * UNIT;
  const w = (p.size[0] + expandMm * 2) * UNIT;
  const h = (p.size[1] + expandMm * 2) * UNIT;
  const rotAttr = p.rot !== 0 ? `rotate(${num(p.rot)} ${num(cx)} ${num(cy)})` : undefined;

  if (p.shape === 'circle' && Math.abs(w - h) < 1e-4) {
    return el('circle', {
      cx,
      cy,
      r: w / 2,
      class: cls,
      ...(pinAttr ? { 'data-pin': pinAttr } : {}),
    });
  }
  const rx = p.shape === 'oval'
    ? Math.min(w, h) / 2
    : p.shape === 'roundrect'
      ? Math.min(w, h) * (p.roundRadius ?? 0.25)
      : 0;
  return el('rect', {
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    ...(rx > 0 ? { rx } : {}),
    ...(rotAttr ? { transform: rotAttr } : {}),
    class: cls,
    ...(pinAttr ? { 'data-pin': pinAttr } : {}),
  });
}

interface PlacedInfo {
  comp: Component;
  part: PartDef;
  fp: Footprint;
  place: PcbPlace;
  corners: Point[];
  pads: PadInstance[];
}

export function renderPcb(q: Query, opts: PcbRenderOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const showLabels = opts.labels ?? true;
  const activeLayers = new Set<PcbRenderLayer>(opts.layers ?? DEFAULT_LAYERS);
  const style = pcbStyle(theme);

  const hlRefs = new Set<string>();
  const hlNets = new Set<string>();
  for (const h of opts.highlight ?? []) {
    if (h.toLowerCase().startsWith('net:')) hlNets.add(h.slice(4).toUpperCase());
    else hlRefs.add(h.toUpperCase());
  }

  const allPads = pads(q);
  const padsByCompId = new Map<string, PadInstance[]>();
  for (const p of allPads) {
    const list = padsByCompId.get(p.compId) ?? [];
    list.push(p);
    padsByCompId.set(p.compId, list);
  }

  const placed: PlacedInfo[] = [];
  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const pl = parsePcbPlace(comp.place.pcb);
    if (!pl) continue;
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    const fp = footprint(fpName);
    placed.push({
      comp,
      part,
      fp,
      place: pl,
      corners: compCourtyardCorners(fp, pl),
      pads: padsByCompId.get(comp.id) ?? [],
    });
  }

  const tracks = q.circuit.pcb?.tracks ?? [];
  const vias = q.circuit.pcb?.vias ?? [];
  const explicitOutline = q.circuit.pcb?.board?.outline;

  if (placed.length === 0 && tracks.length === 0 && vias.length === 0 && (!explicitOutline || explicitOutline.length < 3)) {
    const box = { x: 0, y: 0, w: 360, h: 120 };
    return svgDoc('pcb', box, [
      el('rect', { x: 0, y: 0, width: box.w, height: box.h, class: 'pcb-bg' }),
      el('text', { x: 180, y: 64, 'text-anchor': 'middle', class: 'pcb-empty' }, 'no pcb placement — layout view=pcb'),
    ], style);
  }

  // Compute content bounds in mm
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expandPt = (pt: Point, pad = 0) => {
    if (pt[0] - pad < minX) minX = pt[0] - pad;
    if (pt[1] - pad < minY) minY = pt[1] - pad;
    if (pt[0] + pad > maxX) maxX = pt[0] + pad;
    if (pt[1] + pad > maxY) maxY = pt[1] + pad;
  };
  for (const pc of placed) {
    for (const c of pc.corners) expandPt(c);
  }
  for (const tr of tracks) {
    for (const pt of tr.points) expandPt(pt, tr.width / 2);
  }
  for (const v of vias) expandPt(v.at, v.size / 2);

  const boardOutline: Point[] = explicitOutline && explicitOutline.length >= 3
    ? explicitOutline
    : [
        [minX - 4, minY - 4],
        [maxX + 4, minY - 4],
        [maxX + 4, maxY + 4],
        [minX - 4, maxY + 4],
      ];
  for (const pt of boardOutline) expandPt(pt);

  // Crop to opts.select if provided and matching placed components
  const selectRefs = opts.select?.length ? new Set(opts.select.map(r => r.toUpperCase())) : undefined;
  const selected = selectRefs ? placed.filter(pc => selectRefs.has(pc.comp.ref.toUpperCase())) : [];
  let viewBounds = { minX, minY, maxX, maxY };
  if (selected.length > 0) {
    let sx1 = Infinity;
    let sy1 = Infinity;
    let sx2 = -Infinity;
    let sy2 = -Infinity;
    for (const pc of selected) {
      const b = polyBounds(pc.corners);
      sx1 = Math.min(sx1, b.minX);
      sy1 = Math.min(sy1, b.minY);
      sx2 = Math.max(sx2, b.maxX);
      sy2 = Math.max(sy2, b.maxY);
    }
    viewBounds = { minX: sx1, minY: sy1, maxX: sx2, maxY: sy2 };
  }

  const marginMm = 4;
  const svgBox = {
    x: (viewBounds.minX - marginMm) * UNIT,
    y: (viewBounds.minY - marginMm) * UNIT,
    w: Math.max(20, (viewBounds.maxX - viewBounds.minX + marginMm * 2) * UNIT),
    h: Math.max(20, (viewBounds.maxY - viewBounds.minY + marginMm * 2) * UNIT),
  };

  const body: string[] = [
    el('rect', { x: svgBox.x, y: svgBox.y, width: svgBox.w, height: svgBox.h, class: 'pcb-bg' }),
  ];

  // Board substrate + Edge.Cuts outline
  const boardPts = boardOutline.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' ');
  body.push(el('polygon', { points: boardPts, class: 'pcb-board' }));
  if (activeLayers.has('outline')) {
    body.push(el('polygon', { points: boardPts, class: 'pcb-outline' }));
  }

  // Group tracks & vias by net name deterministically
  const netNameOf = (netId: string): string => q.circuit.nets[netId]?.name ?? netId;
  const drawTracksForLayer = (layer: 'F' | 'B') => {
    if (!activeLayers.has(layer)) return;
    const byNet = new Map<string, PcbTrack[]>();
    for (const tr of tracks) {
      if (tr.layer !== layer) continue;
      const nName = netNameOf(tr.net);
      const list = byNet.get(nName) ?? [];
      list.push(tr);
      byNet.set(nName, list);
    }
    if (byNet.size === 0) return;
    const cls = layer === 'F' ? 'pcb-track-f' : 'pcb-track-b';
    const groups: string[] = [];
    for (const nName of [...byNet.keys()].sort(naturalCompare)) {
      const hl = hlNets.has(nName.toUpperCase());
      const lines = byNet.get(nName)!.map(tr => el('polyline', {
        points: tr.points.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' '),
        class: cls,
        style: `stroke-width:${num(tr.width * UNIT)}`,
      }));
      groups.push(el('g', { 'data-net': nName, class: hl ? 'pcb-net hl' : 'pcb-net' }, lines));
    }
    body.push(el('g', { class: `pcb-tracks-${layer.toLowerCase()}` }, groups));
  };

  drawTracksForLayer('B');
  drawTracksForLayer('F');

  // Vias
  if ((activeLayers.has('F') || activeLayers.has('B')) && vias.length > 0) {
    const byNet = new Map<string, PcbVia[]>();
    for (const v of vias) {
      const nName = netNameOf(v.net);
      const list = byNet.get(nName) ?? [];
      list.push(v);
      byNet.set(nName, list);
    }
    const groups: string[] = [];
    for (const nName of [...byNet.keys()].sort(naturalCompare)) {
      const hl = hlNets.has(nName.toUpperCase());
      const elems: string[] = [];
      for (const v of byNet.get(nName)!) {
        elems.push(
          el('circle', { cx: v.at[0] * UNIT, cy: v.at[1] * UNIT, r: (v.size / 2 + 0.1) * UNIT, class: 'pcb-mask' }),
          el('circle', { cx: v.at[0] * UNIT, cy: v.at[1] * UNIT, r: (v.size / 2) * UNIT, class: 'pcb-via' }),
          el('circle', { cx: v.at[0] * UNIT, cy: v.at[1] * UNIT, r: (v.drill / 2) * UNIT, class: 'pcb-drill' }),
        );
      }
      groups.push(el('g', { 'data-net': nName, class: hl ? 'pcb-net hl' : 'pcb-net' }, elems));
    }
    body.push(el('g', { class: 'pcb-vias' }, groups));
  }

  // Components (pads + mask openings + drills + silk + ref labels + optional courtyard)
  const boardB = polyBounds(boardOutline);
  const compGroups: string[] = [];
  for (const pc of placed) {
    const hl = hlRefs.has(pc.comp.ref.toUpperCase());
    const children: string[] = [];

    // Pads (B first, then F, then TH)
    const padOrder = [...pc.pads].sort((a, b) => {
      const rank = (l: string) => (l === 'B' ? 0 : l === 'F' ? 1 : 2);
      return rank(a.layers) - rank(b.layers);
    });
    for (const pad of padOrder) {
      const visible = pad.layers === 'TH'
        ? (activeLayers.has('F') || activeLayers.has('B'))
        : activeLayers.has(pad.layers);
      if (!visible) continue;
      const padCls = pad.layers === 'TH' ? 'pcb-pad-th' : pad.layers === 'F' ? 'pcb-pad-f' : 'pcb-pad-b';
      children.push(renderPadShape(pad, 0.1, 'pcb-mask'));
      children.push(renderPadShape(pad, 0, padCls, pad.pinLabel));
      if (pad.drill !== undefined) {
        children.push(el('circle', {
          cx: pad.at[0] * UNIT,
          cy: pad.at[1] * UNIT,
          r: (pad.drill / 2) * UNIT,
          class: 'pcb-drill',
        }));
      }
    }

    // Silkscreen
    if (activeLayers.has('silk')) {
      const silkCls = pc.place.side === 'bottom' ? 'pcb-silk-b' : 'pcb-silk-f';
      const xformParts = [`translate(${num(pc.place.x * UNIT)} ${num(pc.place.y * UNIT)})`];
      if (pc.place.rot !== 0) xformParts.push(`rotate(${num(pc.place.rot)})`);
      if (pc.place.side === 'bottom') xformParts.push('scale(-1 1)');
      const silkEls = pc.fp.silk.map(s => renderSilkShape(s, silkCls)).filter(Boolean);
      if (silkEls.length > 0) {
        children.push(el('g', { transform: xformParts.join(' ') }, silkEls));
      }

      if (showLabels) {
        const cb = polyBounds(pc.corners);
        const cx = ((cb.minX + cb.maxX) / 2) * UNIT;
        const aboveY = cb.minY * UNIT - 3;
        const belowY = cb.maxY * UNIT + 10;
        const refY = aboveY >= boardB.minY * UNIT + 6 ? aboveY : belowY;
        const refCls = pc.place.side === 'bottom' ? 'pcb-ref-b' : 'pcb-ref';
        children.push(el('text', { x: cx, y: refY, 'text-anchor': 'middle', class: refCls }, pc.comp.ref));
      }
    }

    // Optional courtyard
    if (activeLayers.has('courtyard')) {
      const pts = pc.corners.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' ');
      children.push(el('polygon', { points: pts, class: 'pcb-courtyard' }));
    }

    compGroups.push(el('g', {
      'data-ref': pc.comp.ref,
      class: hl ? 'pcb-comp hl' : 'pcb-comp',
    }, children));
  }
  if (compGroups.length > 0) {
    body.push(el('g', { class: 'pcb-components' }, compGroups));
  }

  // Ratsnest
  if (activeLayers.has('ratsnest')) {
    const conns = ratsnest(q).connections;
    if (conns.length > 0) {
      const byNet = new Map<string, Connection[]>();
      for (const c of conns) {
        const list = byNet.get(c.net) ?? [];
        list.push(c);
        byNet.set(c.net, list);
      }
      const groups: string[] = [];
      for (const nName of [...byNet.keys()].sort(naturalCompare)) {
        const hl = hlNets.has(nName.toUpperCase());
        const lines = byNet.get(nName)!.map(c => el('line', {
          x1: c.from[0] * UNIT,
          y1: c.from[1] * UNIT,
          x2: c.to[0] * UNIT,
          y2: c.to[1] * UNIT,
          class: 'pcb-rats',
        }));
        groups.push(el('g', { 'data-net': nName, class: hl ? 'pcb-net hl' : 'pcb-net' }, lines));
      }
      body.push(el('g', { class: 'pcb-ratsnest' }, groups));
    }
  }

  return svgDoc('pcb', svgBox, body, style);
}

/** Check PCB view: delegates to `drc(q)`. */
export function checkPcb(q: Query): DrcIssue[] {
  return drc(q);
}

/** PCB view: footprints, F/B copper, silk, board outline, ratsnest, DRC. */
export const pcb: PcbView = {
  id: 'pcb',
  render: renderPcb,
  autoPlace: autoPlacePcb,
  check: checkPcb,
};
