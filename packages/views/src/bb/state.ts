// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { el, num } from '../svg.ts';
import type { RenderState } from '../types.ts';
import type { Jumper } from './connect.ts';
import type { PlacedComp } from './place.ts';
import { formatVoltageBadge, hasRenderState, voltageColor } from '../sch/state.ts';

type LogicVal = '0' | '1' | 'X' | 'Z';

const LED_PALETTE: Record<string, { fill: string; stroke: string; glow: string }> = {
  red: { fill: '#fa5252', stroke: '#c92a2a', glow: '#ffc9c9' },
  green: { fill: '#40c057', stroke: '#2b8a3e', glow: '#b2f2bb' },
  blue: { fill: '#339af0', stroke: '#1864ab', glow: '#a5d8ff' },
  yellow: { fill: '#fcc419', stroke: '#e67700', glow: '#fff3bf' },
  orange: { fill: '#fd7e14', stroke: '#d9480f', glow: '#ffd8a8' },
  white: { fill: '#f8f9fa', stroke: '#adb5bd', glow: '#ffffff' },
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function normalizeNetState(raw: '0' | '1' | 'X' | 'Z' | number): LogicVal | number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 'X';
  const up = raw.toUpperCase();
  if (up === '0' || up === '1' || up === 'X' || up === 'Z') return up;
  return 'X';
}

function addNetClass(groupSvg: string, cls: string): string {
  const openEnd = groupSvg.indexOf('>');
  if (openEnd < 0) return groupSvg;
  const openTag = groupSvg.slice(0, openEnd);
  const classMatch = openTag.match(/ class="([^"]*)"/);
  if (classMatch) {
    const updated = openTag.replace(/ class="([^"]*)"/, ` class="${classMatch[1]} ${cls}"`);
    return updated + groupSvg.slice(openEnd);
  }
  return `${openTag} class="${cls}"${groupSvg.slice(openEnd)}`;
}

function drawBbVoltageBadge(x: number, y: number, text: string, color: string): string {
  const w = Math.max(18, text.length * 4.4 + 6);
  const h = 9.5;
  return el('g', { class: 'bb-st-volt' }, [
    el('rect', {
      x: x - w / 2,
      y: y - h - 2,
      width: w,
      height: h,
      rx: 2.2,
      class: 'bb-st-volt-bg',
      stroke: color,
    }),
    el('text', {
      x,
      y: y - 4.3,
      'text-anchor': 'middle',
      class: 'bb-st-volt-lbl',
      fill: color,
    }, text),
  ]);
}

function buildPartStateOverlay(
  pc: PlacedComp,
  ps: { on?: boolean; level?: number },
): { before: string[]; after: string[]; needsGlowDef: boolean } {
  if (pc.family === 'led') {
    const level = ps.level !== undefined ? clamp01(ps.level) : (ps.on ? 1 : 0);
    if (level <= 0) return { before: [], after: [], needsGlowDef: false };
    const [p1, p2] = pc.pins;
    if (!p1 || !p2) return { before: [], after: [], needsGlowDef: false };
    const mx = (p1.pt.x + p2.pt.x) / 2;
    const my = (p1.pt.y + p2.pt.y) / 2;
    const colorName = (pc.comp.props.color ?? 'red').toLowerCase();
    const pal = LED_PALETTE[colorName] ?? LED_PALETTE.red!;

    const before = [
      el('circle', {
        cx: mx,
        cy: my,
        r: 14,
        fill: pal.glow,
        'fill-opacity': num(0.85 * level),
        filter: 'url(#bb-led-glow)',
      }),
      el('circle', {
        cx: mx,
        cy: my,
        r: 9,
        fill: pal.fill,
        'fill-opacity': num(0.45 * level),
      }),
    ];
    const after = [
      el('circle', {
        cx: mx,
        cy: my,
        r: 5.0,
        fill: pal.fill,
        'fill-opacity': num(0.4 + 0.6 * level),
      }),
      el('circle', {
        cx: mx - 1.1,
        cy: my - 1.1,
        r: 2.1,
        fill: '#ffffff',
        'fill-opacity': num(0.85 * level),
      }),
    ];
    return { before, after, needsGlowDef: true };
  }

  if (pc.family === 'button' && (ps.on !== undefined || ps.level !== undefined)) {
    const pressed = ps.on !== undefined ? ps.on : (ps.level ?? 0) > 0.5;
    if (pc.pins.length === 0) return { before: [], after: [], needsGlowDef: false };
    const mx = pc.pins.reduce((s, p) => s + p.pt.x, 0) / pc.pins.length;
    const my = pc.pins.reduce((s, p) => s + p.pt.y, 0) / pc.pins.length;
    const after = pressed
      ? [
          el('circle', { cx: mx, cy: my, r: 4.5, fill: '#7f1d1d' }),
          el('circle', { cx: mx, cy: my + 0.6, r: 3.9, fill: '#e03131', stroke: '#ffc9c9', 'stroke-width': 0.8 }),
        ]
      : [
          el('circle', { cx: mx, cy: my, r: 4.4, fill: '#1e293b', stroke: '#94a3b8', 'stroke-width': 0.8 }),
        ];
    return { before: [], after, needsGlowDef: false };
  }

  if (pc.family === 'slide_switch' && (ps.on !== undefined || ps.level !== undefined)) {
    const closed = ps.on !== undefined ? ps.on : (ps.level ?? 0) > 0.5;
    if (pc.pins.length === 0) return { before: [], after: [], needsGlowDef: false };
    const mx = pc.pins.reduce((s, p) => s + p.pt.x, 0) / pc.pins.length;
    const my = pc.pins.reduce((s, p) => s + p.pt.y, 0) / pc.pins.length;
    const knobX = closed ? mx + 1.5 : mx - 5.5;
    const after = [
      el('rect', { x: mx - 7.5, y: my - 3.2, width: 15, height: 6.4, rx: 1, fill: '#1e293b' }),
      el('rect', { x: knobX, y: my - 2.8, width: 4.5, height: 5.6, rx: 0.8, fill: closed ? '#ff6b6b' : '#e2e8f0' }),
    ];
    return { before: [], after, needsGlowDef: false };
  }

  return { before: [], after: [], needsGlowDef: false };
}

function injectIntoPartGroup(partSvg: string, before: string[], after: string[]): string {
  const openEnd = partSvg.indexOf('>');
  const closeStart = partSvg.lastIndexOf('</g>');
  if (openEnd < 0 || closeStart < 0) return partSvg;
  return partSvg.slice(0, openEnd + 1) + before.join('') + partSvg.slice(openEnd + 1, closeStart) + after.join('') + partSvg.slice(closeStart);
}

export interface BbStateOverlay {
  partsSvg: string[];
  jumpersSvg: string[];
  pinDots: string[];
  voltageBadges: string[];
  extraStyle: string;
  defs: string[];
}

export { hasRenderState };

/** Compute deterministic breadboard live-state overlays, classes, and CSS rules. */
export function buildBbStateOverlay(
  q: Query,
  placed: PlacedComp[],
  partsSvg: string[],
  jumpers: Jumper[],
  jumpersSvg: string[],
  state: RenderState,
  theme: 'light' | 'dark',
): BbStateOverlay {
  const dark = theme === 'dark';
  const netLookup = new Map<string, LogicVal | number>();
  for (const [k, v] of Object.entries(state.nets ?? {})) {
    netLookup.set(k.toUpperCase(), normalizeNetState(v));
  }
  const partLookup = new Map<string, { on?: boolean; level?: number }>();
  for (const [k, v] of Object.entries(state.parts ?? {})) {
    partLookup.set(k.toUpperCase(), v);
  }

  const c1 = dark ? '#ff6b6b' : '#e03131';
  const c0 = dark ? '#4dabf7' : '#1971c2';
  const cx = dark ? '#fbbf24' : '#d97706';
  const cz = dark ? '#6c757d' : '#868e96';
  const badgeBg = dark ? '#181a1f' : '#ffffff';

  const firstJumperPt = new Map<string, { x: number; y: number }>();
  for (const j of jumpers) {
    const up = j.netName.toUpperCase();
    if (!firstJumperPt.has(up)) {
      firstJumperPt.set(up, { x: (j.from.x + j.to.x) / 2, y: (j.from.y + j.to.y) / 2 });
    }
  }
  const firstPinPt = new Map<string, { x: number; y: number }>();
  const pinDots: string[] = [];
  for (const pc of placed) {
    for (const p of pc.pins) {
      const net = q.netOfPin(p.key);
      if (!net) continue;
      const up = net.name.toUpperCase();
      if (!firstPinPt.has(up)) firstPinPt.set(up, p.pt);
      const val = netLookup.get(up);
      if (val !== undefined && !firstJumperPt.has(up) && !p.offBoard) {
        const col = typeof val === 'number'
          ? voltageColor(val, theme)
          : val === '1' ? c1 : val === '0' ? c0 : val === 'X' ? cx : cz;
        pinDots.push(el('circle', {
          cx: p.pt.x,
          cy: p.pt.y,
          r: 2.3,
          fill: 'none',
          stroke: col,
          'stroke-width': 1.1,
          ...(val === 'X' ? { 'stroke-dasharray': '2 1.5' } : {}),
        }));
      }
    }
  }

  const voltRules: string[] = [];
  const voltageBadges: string[] = [];
  let voltIdx = 0;

  const styledJumpers = jumpersSvg.map(g => {
    const m = g.match(/data-net="([^"]+)"/);
    if (!m) return g;
    const netName = m[1]!;
    const up = netName.toUpperCase();
    const val = netLookup.get(up);
    if (val === undefined) return g;

    if (typeof val === 'number') {
      const cls = `st-v${voltIdx++}`;
      const col = voltageColor(val, theme);
      voltRules.push(
        `.bb-net.${cls} .bb-wire{stroke:${col};stroke-width:2.6;opacity:1}`,
        `.bb-net.${cls} circle{fill:${col}}`,
      );
      const pt = firstJumperPt.get(up) ?? firstPinPt.get(up);
      if (pt) voltageBadges.push(drawBbVoltageBadge(pt.x, pt.y, formatVoltageBadge(val), col));
      return addNetClass(g, cls);
    }

    return addNetClass(g, `st-${val.toLowerCase()}`);
  });

  // Also show voltage badge for numeric nets that had no jumpers at all.
  for (const [up, val] of netLookup) {
    if (typeof val !== 'number') continue;
    if (firstJumperPt.has(up)) continue;
    const pt = firstPinPt.get(up);
    if (pt) {
      const yOff = pt.y < 100 ? pt.y + 17 : pt.y - 6;
      voltageBadges.push(drawBbVoltageBadge(pt.x, yOff, formatVoltageBadge(val), voltageColor(val, theme)));
    }
  }

  let needsGlowDef = false;
  const nextPartsSvg = placed.map((pc, idx) => {
    const orig = partsSvg[idx]!;
    const ps = partLookup.get(pc.comp.ref.toUpperCase());
    if (!ps) return orig;
    const eff = buildPartStateOverlay(pc, ps);
    if (eff.needsGlowDef) needsGlowDef = true;
    if (eff.before.length === 0 && eff.after.length === 0) return orig;
    return injectIntoPartGroup(orig, eff.before, eff.after);
  });

  const extraStyle = [
    `.bb-net.st-1 .bb-wire{stroke:${c1};stroke-width:2.7;opacity:1}`,
    `.bb-net.st-1 circle{fill:${c1}}`,
    `.bb-net.st-0 .bb-wire{stroke:${c0};stroke-width:2.2;opacity:1}`,
    `.bb-net.st-0 circle{fill:${c0}}`,
    `.bb-net.st-x .bb-wire{stroke:${cx};stroke-width:2.4;stroke-dasharray:4 3;opacity:1}`,
    `.bb-net.st-x circle{fill:${cx}}`,
    `.bb-net.st-z .bb-wire{stroke:${cz};stroke-width:1.8;opacity:0.85}`,
    `.bb-net.st-z circle{fill:${cz}}`,
    ...voltRules,
    `.bb-st-volt-bg{fill:${badgeBg};fill-opacity:0.92;stroke-width:0.8}`,
    `.bb-st-volt-lbl{font-family:ui-monospace,Consolas,monospace;font-size:5.6px;font-weight:700}`,
  ].join('\n');

  const defs = needsGlowDef
    ? [
        el('defs', {}, [
          el('filter', { id: 'bb-led-glow', x: '-80%', y: '-80%', width: '260%', height: '260%' }, [
            el('feGaussianBlur', { stdDeviation: '3.2' }),
          ]),
        ]),
      ]
    : [];

  return { partsSvg: nextPartsSvg, jumpersSvg: styledJumpers, pinDots, voltageBadges, extraStyle, defs };
}
