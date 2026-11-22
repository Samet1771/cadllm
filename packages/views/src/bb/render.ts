// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Query } from '@cadllm/core';
import { el, path, svgDoc } from '../svg.ts';
import { UNIT, type Pt, type RenderOptions } from '../types.ts';
import {
  ALL_ROWS,
  colToX,
  ROW_PITCH_Y,
  type BoardSpec,
} from './board.ts';
import { analyzeBreadboard, type Jumper } from './connect.ts';
import {
  compBodyBox,
  compLabelText,
  drawLabel,
  drawPlacedComponent,
  labelBoxFor,
} from './parts.ts';
import type { Box, PlacedComp } from './place.ts';

const SIGNAL_COLORS_LIGHT = [
  '#2b8a3e', // green
  '#1971c2', // blue
  '#e67700', // orange
  '#7048e8', // violet
  '#0c8599', // cyan
  '#d9480f', // rust
  '#5c940d', // lime
  '#ae3ec9', // grape
];

const SIGNAL_COLORS_DARK = [
  '#51cf66',
  '#4dabf7',
  '#ffa94d',
  '#9775fa',
  '#3bc9db',
  '#ff922b',
  '#a9e34b',
  '#da77f2',
];

function buildStyle(theme: 'light' | 'dark'): string {
  const dark = theme === 'dark';
  const bg = dark ? '#181a1f' : '#f8f9fa';
  const boardFill = dark ? '#252830' : '#f4f1ea';
  const boardStroke = dark ? '#3b404c' : '#d2cec4';
  const channelFill = dark ? '#1b1e24' : '#e4e0d5';
  const holeFill = dark ? '#111317' : '#26292e';
  const holeRim = dark ? '#343844' : '#c9c4b8';
  const labelFill = dark ? '#9aa0a6' : '#6c757d';
  const compLabelFill = dark ? '#e9ecef' : '#212529';
  const labelBgFill = dark ? '#181a1f' : '#ffffff';
  const leadStroke = dark ? '#adb5bd' : '#868e96';
  const gndWire = dark ? '#4dabf7' : '#212529';
  const plusWire = dark ? '#ff6b6b' : '#e03131';
  const sigColors = dark ? SIGNAL_COLORS_DARK : SIGNAL_COLORS_LIGHT;

  const sigRules = sigColors
    .map((c, i) => `.bb-wire-s${i} { stroke: ${c}; } .bb-tip-s${i} { fill: ${c}; }`)
    .join('\n');

  return `
.bb-bg { fill: ${bg}; }
.bb-board-body { fill: ${boardFill}; stroke: ${boardStroke}; stroke-width: 1.2; }
.bb-channel { fill: ${channelFill}; }
.bb-rail-plus { fill: #e03131; }
.bb-rail-minus { fill: #1971c2; }
.bb-hole { fill: ${holeFill}; stroke: ${holeRim}; stroke-width: 0.5; }
.bb-board-text { fill: ${labelFill}; font-family: ui-monospace, Consolas, monospace; font-size: 4.6px; font-weight: 600; }
.bb-label-bg { fill: ${labelBgFill}; fill-opacity: 0.9; }
.bb-comp-label { fill: ${compLabelFill}; font-family: ui-monospace, Consolas, monospace; font-size: 5.5px; font-weight: 700; }
.bb-lead { stroke: ${leadStroke}; stroke-width: 1.6; stroke-linecap: round; }
.bb-pin-dot { fill: transparent; }
.bb-wire { fill: none; stroke-width: 2.2; stroke-linecap: round; opacity: 0.92; }
.bb-wire-halo { fill: none; stroke: ${bg}; stroke-width: 3.4; stroke-linecap: round; opacity: 0.35; }
.bb-wire-plus { stroke: ${plusWire}; }
.bb-tip-plus { fill: ${plusWire}; }
.bb-wire-gnd { stroke: ${gndWire}; }
.bb-tip-gnd { fill: ${gndWire}; }
${sigRules}
.bb-hl-box { fill: none; stroke: #f59f00; stroke-width: 2; stroke-dasharray: 3 2; }
.bb-net.hl .bb-wire { stroke-width: 3.6; opacity: 1; }
.bb-net.hl .bb-wire-halo { stroke: #f59f00; stroke-width: 5.2; opacity: 0.65; }
`.trim();
}

function drawBoard(board: BoardSpec): string {
  const children: string[] = [
    el('rect', {
      x: 0,
      y: 0,
      width: board.width,
      height: board.height,
      rx: 6,
      class: 'bb-board-body',
    }),
    el('rect', {
      x: 12,
      y: 9.2 * UNIT,
      width: board.width - 24,
      height: 1.6 * UNIT,
      rx: 3,
      class: 'bb-channel',
    }),
    el('rect', { x: 18, y: 0.7 * UNIT, width: board.width - 36, height: 1.4, rx: 0.7, class: 'bb-rail-plus' }),
    el('rect', { x: 18, y: 3.15 * UNIT, width: board.width - 36, height: 1.4, rx: 0.7, class: 'bb-rail-minus' }),
    el('rect', { x: 18, y: 16.7 * UNIT, width: board.width - 36, height: 1.4, rx: 0.7, class: 'bb-rail-plus' }),
    el('rect', { x: 18, y: 19.15 * UNIT, width: board.width - 36, height: 1.4, rx: 0.7, class: 'bb-rail-minus' }),
  ];

  for (const x of [11, board.width - 11]) {
    children.push(
      el('text', { x, y: ROW_PITCH_Y['T+'] * UNIT + 1.5, 'text-anchor': 'middle', class: 'bb-board-text' }, '+'),
      el('text', { x, y: ROW_PITCH_Y['T-'] * UNIT + 1.5, 'text-anchor': 'middle', class: 'bb-board-text' }, '-'),
      el('text', { x, y: ROW_PITCH_Y['B+'] * UNIT + 1.5, 'text-anchor': 'middle', class: 'bb-board-text' }, '+'),
      el('text', { x, y: ROW_PITCH_Y['B-'] * UNIT + 1.5, 'text-anchor': 'middle', class: 'bb-board-text' }, '-'),
    );
  }

  for (const row of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const) {
    const y = ROW_PITCH_Y[row] * UNIT + 1.5;
    children.push(
      el('text', { x: 11, y, 'text-anchor': 'middle', class: 'bb-board-text' }, row),
      el('text', { x: board.width - 11, y, 'text-anchor': 'middle', class: 'bb-board-text' }, row),
    );
  }

  for (let c = 1; c <= board.cols; c++) {
    if (c === 1 || c % 5 === 0 || c === board.cols) {
      const x = colToX(c);
      children.push(
        el('text', { x, y: 3.9 * UNIT, 'text-anchor': 'middle', class: 'bb-board-text' }, String(c)),
        el('text', { x, y: 16.4 * UNIT, 'text-anchor': 'middle', class: 'bb-board-text' }, String(c)),
      );
    }
  }

  for (const row of ALL_ROWS) {
    const hy = ROW_PITCH_Y[row] * UNIT;
    for (let c = 1; c <= board.cols; c++) {
      const hx = colToX(c);
      children.push(
        el('rect', {
          x: hx - 2.3,
          y: hy - 2.3,
          width: 4.6,
          height: 4.6,
          rx: 0.9,
          class: 'bb-hole',
          'data-hole': `${row}${c}`,
        }),
      );
    }
  }

  return el('g', {
    ...(board.comp ? { 'data-ref': board.comp.ref } : {}),
    class: 'bb-board',
  }, children);
}

function boxesIntersect(a: Box, b: Box, pad = 0): boolean {
  return !(
    a.x + a.w + pad <= b.x
    || b.x + b.w + pad <= a.x
    || a.y + a.h + pad <= b.y
    || b.y + b.h + pad <= a.y
  );
}

/** Liang-Barsky segment vs padded box intersection test. */
function segIntersectsBox(p1: Pt, p2: Pt, b: Box, pad = 0): boolean {
  const minX = b.x - pad;
  const minY = b.y - pad;
  const maxX = b.x + b.w + pad;
  const maxY = b.y + b.h + pad;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, p1.x - minX],
    [dx, maxX - p1.x],
    [-dy, p1.y - minY],
    [dy, maxY - p1.y],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

interface RoutedJumper {
  jumper: Jumper;
  ctrl: Pt;
  d: string;
  samples: Pt[];
  aabb: Box;
}

function routeJumper(
  j: Jumper,
  index: number,
  boardHeight: number,
  dipBoxes: Box[],
): RoutedJumper {
  const dx = j.to.x - j.from.x;
  const dy = j.to.y - j.from.y;
  const dist = Math.hypot(dx, dy);
  const mx = (j.from.x + j.to.x) / 2;
  const my = (j.from.y + j.to.y) / 2;

  let ctrl: Pt = { x: mx, y: my };

  if (dist >= 1e-3) {
    // Check if chord crosses any DIP IC body; route cleanly around its nearest side
    let routedAroundDip = false;
    for (const box of dipBoxes) {
      if (segIntersectsBox(j.from, j.to, box, 4)) {
        const clearance = 10 + (index % 3) * 4;
        if (Math.abs(dy) >= Math.abs(dx) * 0.5) {
          const distLeft = Math.abs(mx - box.x);
          const distRight = Math.abs(box.x + box.w - mx);
          const targetX = distLeft <= distRight ? box.x - clearance : box.x + box.w + clearance;
          ctrl = { x: 2 * targetX - mx, y: my };
        } else {
          const distTop = Math.abs(my - box.y);
          const distBot = Math.abs(box.y + box.h - my);
          const targetY = distTop <= distBot ? box.y - clearance : box.y + box.h + clearance;
          ctrl = { x: mx, y: 2 * targetY - my };
        }
        routedAroundDip = true;
        break;
      }
    }

    if (!routedAroundDip) {
      if (j.isBridge) {
        // Gentle left-bowing curve inside the vertical lane between columns
        ctrl = { x: mx - 8, y: my };
      } else {
        let nx = -dy / dist;
        let ny = dx / dist;
        const laneOffset = ((index % 5) - 2) * 2.2;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const wantUp = my < boardHeight * 0.5;
          if ((wantUp && ny > 0) || (!wantUp && ny < 0)) {
            nx = -nx;
            ny = -ny;
          }
        } else if (nx < 0) {
          nx = -nx;
          ny = -ny;
        }
        const bow = Math.min(28, Math.max(7, dist * 0.2)) + laneOffset;
        ctrl = { x: mx + nx * bow, y: my + ny * bow };
      }
    }
  }

  const d = dist < 1e-3
    ? path(['M', j.from.x, j.from.y, 'L', j.to.x, j.to.y])
    : path(['M', j.from.x, j.from.y, 'Q', ctrl.x, ctrl.y, j.to.x, j.to.y]);

  const samples: Pt[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = 10;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const pt: Pt = {
      x: u * u * j.from.x + 2 * u * t * ctrl.x + t * t * j.to.x,
      y: u * u * j.from.y + 2 * u * t * ctrl.y + t * t * j.to.y,
    };
    samples.push(pt);
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  return {
    jumper: j,
    ctrl,
    d,
    samples,
    aabb: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

function chooseLabels(
  placed: PlacedComp[],
  routedJumpers: RoutedJumper[],
): { svgs: Map<string, string>; boxes: Box[] } {
  const out = new Map<string, string>();
  const bodyBoxes = placed.map(pc => compBodyBox(pc));
  const pinBoxes: Box[] = [];
  for (const pc of placed) {
    for (const p of pc.pins) {
      pinBoxes.push({ x: p.pt.x - 2.6, y: p.pt.y - 2.6, w: 5.2, h: 5.2 });
    }
  }
  const jumperHoleBoxes: Box[] = [];
  for (const rj of routedJumpers) {
    jumperHoleBoxes.push(
      { x: rj.jumper.from.x - 3.5, y: rj.jumper.from.y - 3.5, w: 7, h: 7 },
      { x: rj.jumper.to.x - 3.5, y: rj.jumper.to.y - 3.5, w: 7, h: 7 },
    );
  }
  const placedLabelBoxes: Box[] = [];

  for (let idx = 0; idx < placed.length; idx++) {
    const pc = placed[idx]!;
    const text = compLabelText(pc);
    if (!text) continue;

    const b = bodyBoxes[idx]!;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const vertical =
      !pc.offBoard
      && pc.pins.length === 2
      && Math.abs(pc.pins[1]!.pt.y - pc.pins[0]!.pt.y) > Math.abs(pc.pins[1]!.pt.x - pc.pins[0]!.pt.x);

    interface Cand { x: number; y: number; anchor: 'start' | 'middle' | 'end' }
    const above: Cand = { x: cx, y: b.y - 3.2, anchor: 'middle' };
    const below: Cand = { x: cx, y: b.y + b.h + 7.5, anchor: 'middle' };
    const right: Cand = { x: b.x + b.w + 3.5, y: cy + 1.8, anchor: 'start' };
    const left: Cand = { x: b.x - 3.5, y: cy + 1.8, anchor: 'end' };
    const aboveLeft: Cand = { x: cx - 7, y: b.y - 3.2, anchor: 'middle' };
    const aboveRight: Cand = { x: cx + 7, y: b.y - 3.2, anchor: 'middle' };
    const belowLeft: Cand = { x: cx - 7, y: b.y + b.h + 7.5, anchor: 'middle' };
    const belowRight: Cand = { x: cx + 7, y: b.y + b.h + 7.5, anchor: 'middle' };
    const aboveHigh: Cand = { x: cx, y: b.y - 9.5, anchor: 'middle' };
    const belowLow: Cand = { x: cx, y: b.y + b.h + 13.8, anchor: 'middle' };

    const cands: Cand[] = vertical
      ? [right, left, above, below, aboveRight, belowRight, aboveLeft, belowLeft, aboveHigh, belowLow]
      : [above, below, right, left, aboveRight, aboveLeft, belowRight, belowLeft, aboveHigh, belowLow];

    let best: { cand: Cand; box: Box; score: number } | undefined;

    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci]!;
      const box = labelBoxFor(cand.x, cand.y, text, cand.anchor);
      let score = ci * 0.5;

      for (const bb of bodyBoxes) {
        if (boxesIntersect(box, bb, 0.8)) score += 1200;
      }
      for (const jhb of jumperHoleBoxes) {
        if (boxesIntersect(box, jhb, 0.5)) score += 1000;
      }
      for (const rj of routedJumpers) {
        if (!boxesIntersect(box, rj.aabb, 2.2)) continue;
        score += 40;
        let hitPath = false;
        for (let s = 0; s < rj.samples.length - 1; s++) {
          if (segIntersectsBox(rj.samples[s]!, rj.samples[s + 1]!, box, 2.0)) {
            hitPath = true;
            break;
          }
        }
        if (hitPath) score += 900;
      }
      for (const lb of placedLabelBoxes) {
        if (boxesIntersect(box, lb, 1.0)) score += 800;
      }
      for (const pb of pinBoxes) {
        if (boxesIntersect(box, pb, 0.3)) score += 150;
      }

      if (!best || score < best.score - 1e-6) {
        best = { cand, box, score };
      }
    }

    if (best) {
      placedLabelBoxes.push(best.box);
      out.set(pc.comp.id, drawLabel(best.cand.x, best.cand.y, text, best.cand.anchor));
    }
  }

  return { svgs: out, boxes: placedLabelBoxes };
}

function drawJumpers(
  routed: RoutedJumper[],
  highlightedNets: Set<string>,
): string[] {
  const byNet = new Map<string, RoutedJumper[]>();
  for (const rj of routed) {
    const list = byNet.get(rj.jumper.netName) ?? [];
    list.push(rj);
    byNet.set(rj.jumper.netName, list);
  }

  const groups: string[] = [];
  for (const netName of [...byNet.keys()].sort(naturalCompare)) {
    const list = byNet.get(netName)!;
    const hl = highlightedNets.has(netName.toUpperCase());
    const children: string[] = [];

    for (const rj of list) {
      const j = rj.jumper;
      const clsSuffix = j.role === 'plus' ? 'plus' : j.role === 'gnd' ? 'gnd' : `s${j.colorIndex}`;
      children.push(
        el('path', { d: rj.d, class: 'bb-wire-halo' }),
        el('path', { d: rj.d, class: `bb-wire bb-wire-${clsSuffix}` }),
        el('circle', { cx: j.from.x, cy: j.from.y, r: 1.6, class: `bb-tip-${clsSuffix}` }),
        el('circle', { cx: j.to.x, cy: j.to.y, r: 1.6, class: `bb-tip-${clsSuffix}` }),
      );
    }

    groups.push(
      el('g', {
        'data-net': netName,
        class: hl ? 'bb-net hl' : 'bb-net',
      }, children),
    );
  }
  return groups;
}

export function renderBreadboard(q: Query, opts: RenderOptions = {}): string {
  const analysis = analyzeBreadboard(q);
  const { board, placed, jumpers } = analysis;
  const theme = opts.theme ?? 'light';
  const labels = opts.labels ?? true;

  const hlRefs = new Set<string>();
  const hlNets = new Set<string>();
  for (const h of opts.highlight ?? []) {
    if (h.toLowerCase().startsWith('net:')) hlNets.add(h.slice(4).toUpperCase());
    else hlRefs.add(h.toUpperCase());
  }

  // Deterministic jumper routing before label placement so labels avoid jumper paths & endpoints
  const dipBoxes = placed.filter(pc => pc.family === 'dip').map(pc => compBodyBox(pc));
  const sortedJumpers = [...jumpers].sort(
    (a, b) => naturalCompare(a.netName, b.netName) || a.from.x - b.from.x || a.from.y - b.from.y || a.to.x - b.to.x,
  );
  const routedJumpers = sortedJumpers.map((j, i) => routeJumper(j, i, board.height, dipBoxes));
  const labelResult = labels ? chooseLabels(placed, routedJumpers) : { svgs: new Map<string, string>(), boxes: [] as Box[] };

  let minX = -2 * UNIT;
  let minY = -2 * UNIT;
  let maxX = board.width + 2 * UNIT;
  let maxY = board.height + 2 * UNIT;

  for (const pc of placed) {
    minX = Math.min(minX, pc.box.x - 2 * UNIT);
    minY = Math.min(minY, pc.box.y - 2 * UNIT);
    maxX = Math.max(maxX, pc.box.x + pc.box.w + 2 * UNIT);
    maxY = Math.max(maxY, pc.box.y + pc.box.h + 2 * UNIT);
  }
  for (const lb of labelResult.boxes) {
    minX = Math.min(minX, lb.x - UNIT);
    minY = Math.min(minY, lb.y - UNIT);
    maxX = Math.max(maxX, lb.x + lb.w + UNIT);
    maxY = Math.max(maxY, lb.y + lb.h + UNIT);
  }

  if (opts.select && opts.select.length > 0) {
    const selSet = new Set(opts.select.map(s => s.toUpperCase()));
    const matched = placed.filter(pc => selSet.has(pc.comp.ref.toUpperCase()));
    if (matched.length > 0) {
      let sx1 = Infinity;
      let sy1 = Infinity;
      let sx2 = -Infinity;
      let sy2 = -Infinity;
      for (const pc of matched) {
        sx1 = Math.min(sx1, pc.box.x);
        sy1 = Math.min(sy1, pc.box.y);
        sx2 = Math.max(sx2, pc.box.x + pc.box.w);
        sy2 = Math.max(sy2, pc.box.y + pc.box.h);
      }
      const pad = 3 * UNIT;
      minX = sx1 - pad;
      minY = sy1 - pad;
      maxX = sx2 + pad;
      maxY = sy2 + pad;
    }
  }

  const viewBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const bg = el('rect', { x: viewBox.x, y: viewBox.y, width: viewBox.w, height: viewBox.h, class: 'bb-bg' });
  const boardSvg = drawBoard(board);
  const partsSvg = placed.map(pc =>
    drawPlacedComponent(q, pc, hlRefs.has(pc.comp.ref.toUpperCase()), labels, labelResult.svgs.get(pc.comp.id)),
  );
  const jumpersSvg = drawJumpers(routedJumpers, hlNets);

  return svgDoc('bb', viewBox, [bg, boardSvg, ...partsSvg, ...jumpersSvg], buildStyle(theme));
}
