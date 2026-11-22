// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { el, num, path } from '../svg.ts';
import { UNIT, type RenderState } from '../types.ts';
import { svgTransform } from './symbols/common.ts';
import type { PlacedSymbol } from './types.ts';

type LogicVal = '0' | '1' | 'X' | 'Z';

const LED_COLORS: Record<string, { fill: string; stroke: string; glow: string }> = {
  red: { fill: '#fa5252', stroke: '#c92a2a', glow: '#ff8787' },
  green: { fill: '#40c057', stroke: '#2b8a3e', glow: '#8ce99a' },
  blue: { fill: '#339af0', stroke: '#1864ab', glow: '#74c0fc' },
  yellow: { fill: '#fcc419', stroke: '#e67700', glow: '#ffe066' },
  orange: { fill: '#fd7e14', stroke: '#d9480f', glow: '#ffa94d' },
  white: { fill: '#f8f9fa', stroke: '#adb5bd', glow: '#ffffff' },
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function lerpHex(a: [number, number, number], b: [number, number, number], t: number): string {
  const u = clamp01(t);
  const r = Math.round(a[0] + (b[0] - a[0]) * u);
  const g = Math.round(a[1] + (b[1] - a[1]) * u);
  const bl = Math.round(a[2] + (b[2] - a[2]) * u);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

export function voltageColor(volts: number, theme: 'light' | 'dark'): string {
  if (volts < 0) return theme === 'dark' ? '#748ffc' : '#3b5bdb';
  const low: [number, number, number] = theme === 'dark' ? [77, 171, 247] : [25, 113, 194];
  const mid: [number, number, number] = theme === 'dark' ? [255, 169, 77] : [230, 119, 0];
  const high: [number, number, number] = theme === 'dark' ? [255, 107, 107] : [224, 49, 49];
  const t = clamp01(volts / 5);
  return t <= 0.5 ? lerpHex(low, mid, t * 2) : lerpHex(mid, high, (t - 0.5) * 2);
}

export function formatVoltageBadge(volts: number): string {
  if (Math.abs(volts) < 0.005) return '0V';
  if (Math.abs(volts) < 1) return `${num(volts * 1000)}mV`;
  return `${num(volts)}V`;
}

export function hasRenderState(state?: RenderState): state is RenderState {
  if (!state) return false;
  return Boolean(
    (state.nets && Object.keys(state.nets).length > 0)
    || (state.parts && Object.keys(state.parts).length > 0),
  );
}

function normalizeNetState(raw: '0' | '1' | 'X' | 'Z' | number): LogicVal | number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 'X';
  const up = raw.toUpperCase();
  if (up === '0' || up === '1' || up === 'X' || up === 'Z') return up;
  return 'X';
}

function buildNetLookup(state: RenderState): Map<string, LogicVal | number> {
  const map = new Map<string, LogicVal | number>();
  for (const [k, v] of Object.entries(state.nets ?? {})) {
    map.set(k.toUpperCase(), normalizeNetState(v));
  }
  return map;
}

function buildPartLookup(state: RenderState): Map<string, { on?: boolean; level?: number }> {
  const map = new Map<string, { on?: boolean; level?: number }>();
  for (const [k, v] of Object.entries(state.parts ?? {})) {
    map.set(k.toUpperCase(), v);
  }
  return map;
}

function addGroupClass(groupSvg: string, cls: string): string {
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

function firstPathMidpoint(groupSvg: string): { x: number; y: number } | undefined {
  const m = groupSvg.match(/<path d="M ([\d.-]+) ([\d.-]+)(?: L ([\d.-]+) ([\d.-]+))?/);
  if (!m) return undefined;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  if (m[3] !== undefined && m[4] !== undefined) {
    return { x: (x1 + Number(m[3])) / 2, y: (y1 + Number(m[4])) / 2 };
  }
  return { x: x1, y: y1 };
}

function drawVoltageBadge(x: number, y: number, text: string, color: string): string {
  const w = Math.max(18, text.length * 4.8 + 6);
  const h = 10;
  return el('g', { class: 'st-volt' }, [
    el('rect', {
      x: x - w / 2,
      y: y - h - 2,
      width: w,
      height: h,
      rx: 2.5,
      class: 'st-volt-bg',
      stroke: color,
    }),
    el('text', {
      x,
      y: y - 4.5,
      'text-anchor': 'middle',
      class: 'st-volt-lbl',
      fill: color,
    }, text),
  ]);
}

function partBodyReplacement(
  s: PlacedSymbol,
  ps: { on?: boolean; level?: number },
  theme: 'light' | 'dark',
): { before: string[]; after: string[]; replaceBody0?: string; needsGlowDef: boolean } {
  if (s.family === 'led') {
    const level = ps.level !== undefined ? clamp01(ps.level) : (ps.on ? 1 : 0);
    if (level <= 0) return { before: [], after: [], needsGlowDef: false };
    const colorName = (s.comp.props.color ?? 'red').toLowerCase();
    const pal = LED_COLORS[colorName] ?? LED_COLORS.red!;
    const cx = s.place.x * UNIT;
    const cy = s.place.y * UNIT;
    const tri = path(['M', -6, -7, 'L', 6, 0, 'L', -6, 7, 'Z']);
    const rays = path([
      'M', -2, -9, 'L', 4, -15,
      'M', 1.5, -15, 'L', 4, -15, 'L', 4, -12.5,
      'M', 3, -8, 'L', 9, -14,
      'M', 6.5, -14, 'L', 9, -14, 'L', 9, -11.5,
    ]);
    const before = [
      el('circle', {
        cx,
        cy,
        r: 15,
        fill: pal.glow,
        'fill-opacity': num(0.75 * level),
        filter: 'url(#sch-led-glow)',
      }),
      el('circle', {
        cx,
        cy,
        r: 10,
        fill: pal.fill,
        'fill-opacity': num(0.32 * level),
      }),
    ];
    const after = [
      el('g', { transform: svgTransform(s.place) }, [
        el('path', {
          d: tri,
          fill: pal.fill,
          'fill-opacity': num(0.35 + 0.65 * level),
          stroke: pal.stroke,
          'stroke-width': 1.6,
          'stroke-linejoin': 'round',
        }),
        el('path', {
          d: rays,
          fill: 'none',
          stroke: pal.fill,
          'stroke-width': 2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'stroke-opacity': num(0.45 + 0.55 * level),
        }),
      ]),
    ];
    return { before, after, needsGlowDef: true };
  }

  if (s.family === 'button' && (ps.on !== undefined || ps.level !== undefined)) {
    const pressed = ps.on !== undefined ? ps.on : (ps.level ?? 0) > 0.5;
    const barY = pressed ? -2 : -7;
    const leads = path(['M', -20, 0, 'L', -10, 0, 'M', 10, 0, 'L', 20, 0]);
    const bridge = path([
      'M', -9, barY, 'L', 9, barY,
      'M', 0, barY, 'L', 0, barY - 6,
      'M', -4, barY - 6, 'L', 4, barY - 6,
    ]);
    const pressColor = theme === 'dark' ? '#ff6b6b' : '#e03131';
    const bodyEls = [
      el('path', { d: leads, class: 'sym' }),
      el('circle', { cx: -8, cy: 0, r: 2, class: 'sym' }),
      el('circle', { cx: 8, cy: 0, r: 2, class: 'sym' }),
      el('path', {
        d: bridge,
        ...(pressed ? { stroke: pressColor, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' } : { class: 'sym' }),
      }),
      ...(pressed ? [el('circle', { cx: 0, cy: -8, r: 2.2, fill: pressColor })] : []),
    ];
    return {
      before: [],
      after: [],
      replaceBody0: el('g', { transform: svgTransform(s.place) }, bodyEls),
      needsGlowDef: false,
    };
  }

  if (s.family === 'switch' && (ps.on !== undefined || ps.level !== undefined)) {
    const closed = ps.on !== undefined ? ps.on : (ps.level ?? 0) > 0.5;
    const leads = path(['M', -20, 0, 'L', -10, 0, 'M', 10, 0, 'L', 20, 0]);
    const blade = closed ? path(['M', -6, 0, 'L', 8, 0]) : path(['M', -6.5, -1, 'L', 7.5, -9]);
    const bodyEls = [
      el('path', { d: leads, class: 'sym' }),
      el('circle', { cx: -8, cy: 0, r: 2, class: 'sym' }),
      el('circle', { cx: 8, cy: 0, r: 2, class: 'sym' }),
      el('path', { d: blade, class: 'sym' }),
    ];
    return {
      before: [],
      after: [],
      replaceBody0: el('g', { transform: svgTransform(s.place) }, bodyEls),
      needsGlowDef: false,
    };
  }

  return { before: [], after: [], needsGlowDef: false };
}

export interface SchStateOverlay {
  netGroups: string[];
  compEffects: Map<string, { before: string[]; after: string[]; replaceBody0?: string }>;
  voltageBadges: string[];
  extraStyle: string;
  defs: string[];
}

/** Compute deterministic schematic live-state overlays, classes, and CSS rules. */
export function buildSchStateOverlay(
  _q: Query,
  symbols: PlacedSymbol[],
  netGroups: string[],
  state: RenderState,
  theme: 'light' | 'dark',
): SchStateOverlay {
  const netLookup = buildNetLookup(state);
  const partLookup = buildPartLookup(state);
  const dark = theme === 'dark';

  const c1 = dark ? '#ff6b6b' : '#e03131';
  const c0 = dark ? '#4dabf7' : '#1971c2';
  const cx = dark ? '#fbbf24' : '#d97706';
  const cz = dark ? '#6c757d' : '#868e96';
  const badgeBg = dark ? '#0f172a' : '#ffffff';
  const mono = "Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";

  const voltRules: string[] = [];
  const voltageBadges: string[] = [];
  let voltIdx = 0;

  const styledNetGroups = netGroups.map(g => {
    const m = g.match(/data-net="([^"]+)"/);
    if (!m) return g;
    const netName = m[1]!;
    const val = netLookup.get(netName.toUpperCase());
    if (val === undefined) return g;

    if (typeof val === 'number') {
      const cls = `st-v${voltIdx++}`;
      const col = voltageColor(val, theme);
      voltRules.push(
        `.${cls} .wire,.${cls} .pwr-wire,.${cls} .pwr-sym,.${cls} .gnd-wire,.${cls} .gnd-sym{stroke:${col};stroke-width:2.1}`,
        `.${cls} .junc{fill:${col}}`,
        `.${cls} .pwr-lbl,.${cls} .gnd-lbl{fill:${col}}`,
      );
      const pt = firstPathMidpoint(g);
      if (pt) voltageBadges.push(drawVoltageBadge(pt.x, pt.y, formatVoltageBadge(val), col));
      return addGroupClass(g, cls);
    }

    const cls = `st-${val.toLowerCase()}`;
    return addGroupClass(g, cls);
  });

  const compEffects = new Map<string, { before: string[]; after: string[]; replaceBody0?: string }>();
  let needsGlowDef = false;
  for (const s of symbols) {
    const ps = partLookup.get(s.comp.ref.toUpperCase());
    if (!ps) continue;
    const eff = partBodyReplacement(s, ps, theme);
    if (eff.needsGlowDef) needsGlowDef = true;
    if (eff.before.length > 0 || eff.after.length > 0 || eff.replaceBody0 !== undefined) {
      compEffects.set(s.comp.ref, {
        before: eff.before,
        after: eff.after,
        ...(eff.replaceBody0 !== undefined ? { replaceBody0: eff.replaceBody0 } : {}),
      });
    }
  }

  const stateCss = [
    `.st-1 .wire,.st-1 .pwr-wire,.st-1 .pwr-sym,.st-1 .gnd-wire,.st-1 .gnd-sym{stroke:${c1};stroke-width:2.2}`,
    `.st-1 .junc{fill:${c1}}`,
    `.st-1 .pwr-lbl,.st-1 .gnd-lbl{fill:${c1}}`,
    `.st-0 .wire,.st-0 .pwr-wire,.st-0 .pwr-sym,.st-0 .gnd-wire,.st-0 .gnd-sym{stroke:${c0};stroke-width:1.8}`,
    `.st-0 .junc{fill:${c0}}`,
    `.st-0 .pwr-lbl,.st-0 .gnd-lbl{fill:${c0}}`,
    `.st-x .wire,.st-x .pwr-wire,.st-x .gnd-wire{stroke:${cx};stroke-width:2;stroke-dasharray:4 3}`,
    `.st-x .junc{fill:${cx}}`,
    `.st-x .pwr-lbl,.st-x .gnd-lbl{fill:${cx}}`,
    `.st-z .wire,.st-z .pwr-wire,.st-z .gnd-wire{stroke:${cz};stroke-width:1.4}`,
    `.st-z .junc{fill:${cz}}`,
    `.st-z .pwr-lbl,.st-z .gnd-lbl{fill:${cz}}`,
    ...voltRules,
    `.st-volt-bg{fill:${badgeBg};fill-opacity:0.92;stroke-width:0.9}`,
    `.st-volt-lbl{font-family:${mono};font-size:6.8px;font-weight:700}`,
  ].join('');

  const defs = needsGlowDef
    ? [
        el('defs', {}, [
          el('filter', { id: 'sch-led-glow', x: '-80%', y: '-80%', width: '260%', height: '260%' }, [
            el('feGaussianBlur', { stdDeviation: '3.2' }),
          ]),
        ]),
      ]
    : [];

  return { netGroups: styledNetGroups, compEffects, voltageBadges, extraStyle: stateCss, defs };
}
