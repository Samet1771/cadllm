// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { el, svgDoc } from '../svg.ts';
import { UNIT, type RenderOptions } from '../types.ts';
import { resolveSchFamily } from './nets.ts';
import { parseSchPlace } from './place.ts';
import { routeNets } from './route.ts';
import { buildSymbol } from './symbols/index.ts';
import { buildSchStateOverlay, hasRenderState } from './state.ts';
import { schStyle } from './theme.ts';
import type { GridBox, PlacedSymbol } from './types.ts';

function mergeBox(a: GridBox | undefined, b: GridBox | undefined): GridBox | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function renderSchematic(q: Query, opts: RenderOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const showLabels = opts.labels ?? true;
  const style = schStyle(theme);

  const highlightRefs = new Set<string>();
  const highlightNets = new Set<string>();
  for (const h of opts.highlight ?? []) {
    if (h.toLowerCase().startsWith('net:')) {
      highlightNets.add(h.slice(4).toUpperCase());
    } else {
      highlightRefs.add(h.toUpperCase());
    }
  }

  const symbols: PlacedSymbol[] = [];
  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part) continue;
    if (resolveSchFamily(part) === 'none') continue;
    const raw = comp.place['sch'];
    if (!raw) continue;
    const parsed = parseSchPlace(raw);
    if (!parsed) continue;
    symbols.push(buildSymbol(q, comp, part, parsed));
  }

  if (symbols.length === 0) {
    const box = { x: 0, y: 0, w: 360, h: 120 };
    const body = [
      el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, class: 'bg' }),
      el('text', { x: 180, y: 64, 'text-anchor': 'middle', class: 'empty-msg' }, 'no schematic placement — layout view=sch'),
    ];
    return svgDoc('sch', box, body, style);
  }

  const routed = routeNets(q, symbols, highlightNets);

  // Determine bounding box (cropped to opts.select if provided and matching placed symbols).
  const selectRefs = opts.select?.length
    ? new Set(opts.select.map(r => r.toUpperCase()))
    : undefined;
  const selectedSymbols = selectRefs
    ? symbols.filter(s => selectRefs.has(s.comp.ref.toUpperCase()))
    : [];

  let gridBounds: GridBox | undefined;
  if (selectedSymbols.length > 0) {
    for (const s of selectedSymbols) gridBounds = mergeBox(gridBounds, s.fullBox);
  } else {
    for (const s of symbols) gridBounds = mergeBox(gridBounds, s.fullBox);
    gridBounds = mergeBox(gridBounds, routed.bounds);
  }

  const margin = 2.5;
  const b = gridBounds ?? { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  const svgBox = {
    x: (b.minX - margin) * UNIT,
    y: (b.minY - margin) * UNIT,
    w: (b.maxX - b.minX + margin * 2) * UNIT,
    h: (b.maxY - b.minY + margin * 2) * UNIT,
  };

  const buildCompGroup = (
    s: PlacedSymbol,
    bodyEls: string[],
    before: string[] = [],
    after: string[] = [],
  ): string => {
    const isHl = highlightRefs.has(s.comp.ref.toUpperCase());
    const children: string[] = [...before, ...bodyEls, ...after];

    if (showLabels) {
      for (const lbl of s.labels) {
        children.push(el('text', {
          x: lbl.x,
          y: lbl.y,
          'text-anchor': lbl.anchor,
          class: lbl.kind === 'ref' ? 'lbl-ref' : 'lbl-val',
        }, lbl.text));
      }
    }

    for (const pp of s.pins) {
      children.push(el('circle', {
        cx: pp.gx * UNIT,
        cy: pp.gy * UNIT,
        r: 1.6,
        class: 'pin',
        'data-pin': pp.label,
      }));
    }

    return el('g', { 'data-ref': s.comp.ref, class: isHl ? 'hl' : undefined }, children);
  };

  if (!hasRenderState(opts.state)) {
    const compGroups = symbols.map(s => buildCompGroup(s, s.bodySvg));
    const body = [
      el('rect', { x: svgBox.x, y: svgBox.y, width: svgBox.w, height: svgBox.h, class: 'bg' }),
      el('g', { class: 'wires' }, routed.netGroups),
      el('g', { class: 'components' }, compGroups),
    ];

    return svgDoc('sch', svgBox, body, style);
  }

  const st = buildSchStateOverlay(q, symbols, routed.netGroups, opts.state, theme);
  const stateCompGroups = symbols.map(s => {
    const eff = st.compEffects.get(s.comp.ref);
    if (!eff) return buildCompGroup(s, s.bodySvg);
    const baseBody = eff.replaceBody0 !== undefined && s.bodySvg.length > 0
      ? [eff.replaceBody0, ...s.bodySvg.slice(1)]
      : s.bodySvg;
    return buildCompGroup(s, baseBody, eff.before, eff.after);
  });

  const body = [
    ...st.defs,
    el('rect', { x: svgBox.x, y: svgBox.y, width: svgBox.w, height: svgBox.h, class: 'bg' }),
    el('g', { class: 'wires' }, st.netGroups),
    el('g', { class: 'components' }, stateCompGroups),
    ...(st.voltageBadges.length > 0 ? [el('g', { class: 'state-annotations' }, st.voltageBadges)] : []),
  ];

  return svgDoc('sch', svgBox, body, `${style}${st.extraStyle}`);
}
