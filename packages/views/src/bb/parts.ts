// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { parseSI, type Query } from '@cadllm/core';
import { el, num, path } from '../svg.ts';
import type { Box, PinPlacement, PlacedComp } from './place.ts';

const BAND_COLORS = [
  '#1b1d21', // 0 black
  '#7c4700', // 1 brown
  '#e03131', // 2 red
  '#f76707', // 3 orange
  '#fcc419', // 4 yellow
  '#2f9e44', // 5 green
  '#1971c2', // 6 blue
  '#7048e8', // 7 violet
  '#868e96', // 8 gray
  '#f8f9fa', // 9 white
];

function resistanceBands(raw: string | undefined): [string, string, string, string] {
  const ohms = parseSI(raw ?? '1k');
  if (ohms === undefined || ohms <= 0) {
    return [BAND_COLORS[1]!, BAND_COLORS[0]!, BAND_COLORS[2]!, '#d4a017'];
  }
  const exp = Math.floor(Math.log10(ohms));
  const scaled = Math.round(ohms / Math.pow(10, exp - 1));
  let d1 = Math.floor(scaled / 10);
  let d2 = scaled % 10;
  let mult = exp - 1;
  if (d1 >= 10) {
    d1 = 1;
    d2 = 0;
    mult += 1;
  }
  const multColor =
    mult === -1 ? '#d4a017' : mult === -2 ? '#adb5bd' : (BAND_COLORS[Math.max(0, Math.min(9, mult))] ?? '#1b1d21');
  return [
    BAND_COLORS[Math.max(0, Math.min(9, d1))]!,
    BAND_COLORS[Math.max(0, Math.min(9, d2))]!,
    multColor,
    '#d4a017',
  ];
}

const LED_PALETTE: Record<string, { fill: string; stroke: string; glow: string }> = {
  red: { fill: '#fa5252', stroke: '#c92a2a', glow: '#ffc9c9' },
  green: { fill: '#40c057', stroke: '#2b8a3e', glow: '#b2f2bb' },
  blue: { fill: '#339af0', stroke: '#1864ab', glow: '#a5d8ff' },
  yellow: { fill: '#fcc419', stroke: '#e67700', glow: '#fff3bf' },
  white: { fill: '#f1f3f5', stroke: '#adb5bd', glow: '#ffffff' },
};

function pinAnchor(p: PinPlacement, r = 1.8): string {
  return el('circle', {
    cx: p.pt.x,
    cy: p.pt.y,
    r,
    class: 'bb-pin-dot',
    'data-pin': p.label,
  });
}

export function labelBoxFor(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'middle'): Box {
  const padX = 2.2;
  const w = text.length * 3.4 + padX * 2;
  const h = 7.2;
  const rx = anchor === 'middle' ? x - w / 2 : anchor === 'start' ? x - padX : x - w + padX;
  return { x: rx, y: y - 5.2, w, h };
}

export function drawLabel(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'middle'): string {
  const box = labelBoxFor(x, y, text, anchor);
  return el('g', { class: 'bb-label-group' }, [
    el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 1.8, class: 'bb-label-bg' }),
    el('text', {
      x,
      y,
      'text-anchor': anchor,
      class: 'bb-comp-label',
    }, text),
  ]);
}

export function compLabelText(pc: PlacedComp): string | undefined {
  if (pc.family === 'dip') return undefined; // drawn inside IC package
  if (pc.family === 'axial') {
    const val = pc.comp.props.resistance ?? pc.comp.props.inductance ?? pc.comp.props.voltage ?? '';
    return val ? `${pc.comp.ref} ${val}` : pc.comp.ref;
  }
  if (pc.family === 'disc' || pc.family === 'radial') {
    const val = pc.comp.props.capacitance ?? '';
    return val ? `${pc.comp.ref} ${val}` : pc.comp.ref;
  }
  if (pc.family === 'unknown') {
    return `${pc.comp.ref} (${pc.comp.part})`;
  }
  return pc.comp.ref;
}

/** Tight visual body bounding box used for label collision avoidance. */
export function compBodyBox(pc: PlacedComp): Box {
  const pins = pc.pins;
  if (pc.family === 'battery' || pc.family === 'supply' || pc.family === 'arduino_uno') {
    return pc.box;
  }
  if (pins.length === 0) return pc.box;
  const xs = pins.map(p => p.pt.x);
  const ys = pins.map(p => p.pt.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const mx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const my = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length;

  switch (pc.family) {
    case 'dip':
      return { x: minX - 4.2, y: minY + 1.8, w: maxX - minX + 8.4, h: maxY - minY - 3.6 };
    case 'button':
      return { x: mx - 8, y: my - 8, w: 16, h: 16 };
    case 'led':
      return { x: mx - 6.8, y: my - 6.8, w: 13.6, h: 13.6 };
    case 'disc':
      return { x: mx - 6.2, y: my - 4.5, w: 12.4, h: 9 };
    case 'radial':
      return { x: mx - 6.4, y: my - 6.4, w: 12.8, h: 12.8 };
    case 'slide_switch':
      return { x: mx - 10, y: my - 5.5, w: 20, h: 11 };
    case 'pot':
      return { x: mx - 9, y: my - 14, w: 18, h: 18 };
    case 'buzzer':
      return { x: mx - 9.5, y: my - 9.5, w: 19, h: 19 };
    case 'to92':
      return { x: mx - 6.5, y: my - 10, w: 13, h: 12 };
    case 'probe':
      return { x: mx - 4.5, y: my - 4.5, w: 9, h: 9 };
    case 'axial': {
      const horiz = Math.abs(maxX - minX) >= Math.abs(maxY - minY);
      return horiz
        ? { x: minX - 2, y: my - 3.6, w: maxX - minX + 4, h: 7.2 }
        : { x: mx - 3.6, y: minY - 2, w: 7.2, h: maxY - minY + 4 };
    }
    default:
      return { x: minX - 4.5, y: minY - 4.5, w: maxX - minX + 9, h: maxY - minY + 9 };
  }
}

function drawLeads(pins: PinPlacement[], cx: number, cy: number): string[] {
  return pins.map(p =>
    el('line', {
      x1: p.pt.x,
      y1: p.pt.y,
      x2: cx,
      y2: cy,
      class: 'bb-lead',
    }),
  );
}

function drawAxial(pc: PlacedComp): string[] {
  const [p1, p2] = pc.pins;
  if (!p1 || !p2) return [];
  const mx = (p1.pt.x + p2.pt.x) / 2;
  const my = (p1.pt.y + p2.pt.y) / 2;
  const angle = (Math.atan2(p2.pt.y - p1.pt.y, p2.pt.x - p1.pt.x) * 180) / Math.PI;
  const parts: string[] = [...drawLeads([p1, p2], mx, my)];

  const bodyLen = Math.min(20, Math.max(12, Math.hypot(p2.pt.x - p1.pt.x, p2.pt.y - p1.pt.y) * 0.55));
  const half = bodyLen / 2;

  const inner: string[] = [];
  if (pc.comp.part === 'diode' || pc.comp.part === 'zener') {
    const fill = pc.comp.part === 'zener' ? '#e8590c' : '#262930';
    const bandFill = pc.comp.part === 'zener' ? '#1b1d21' : '#dee2e6';
    inner.push(
      el('rect', { x: -half, y: -3.2, width: bodyLen, height: 6.4, rx: 1.5, fill, stroke: '#1b1d21', 'stroke-width': 0.7 }),
      el('rect', { x: half - 4.2, y: -3.2, width: 2.2, height: 6.4, fill: bandFill }),
    );
  } else if (pc.comp.part === 'inductor') {
    inner.push(
      el('rect', { x: -half, y: -3.5, width: bodyLen, height: 7, rx: 3.2, fill: '#2b8a3e', stroke: '#1b5e20', 'stroke-width': 0.7 }),
      el('rect', { x: -half + 3, y: -3.5, width: 1.6, height: 7, fill: '#d4a017' }),
      el('rect', { x: 0, y: -3.5, width: 1.6, height: 7, fill: '#1b1d21' }),
      el('rect', { x: half - 4.5, y: -3.5, width: 1.6, height: 7, fill: '#e03131' }),
    );
  } else {
    const [b1, b2, b3, b4] = resistanceBands(pc.comp.props.resistance ?? pc.part?.props?.resistance?.default);
    inner.push(
      el('rect', { x: -half, y: -3.4, width: bodyLen, height: 6.8, rx: 3, fill: '#e5c694', stroke: '#9c7a4c', 'stroke-width': 0.7 }),
      el('rect', { x: -half + 2.6, y: -3.4, width: 1.8, height: 6.8, fill: b1 }),
      el('rect', { x: -half + 5.6, y: -3.4, width: 1.8, height: 6.8, fill: b2 }),
      el('rect', { x: -half + 8.6, y: -3.4, width: 1.8, height: 6.8, fill: b3 }),
      el('rect', { x: half - 3.6, y: -3.4, width: 1.6, height: 6.8, fill: b4 }),
    );
  }

  parts.push(
    el('g', { transform: `translate(${num(mx)},${num(my)}) rotate(${num(angle)})` }, inner),
    pinAnchor(p1),
    pinAnchor(p2),
  );
  return parts;
}

function drawLed(pc: PlacedComp): string[] {
  const [p1, p2] = pc.pins;
  if (!p1 || !p2) return [];
  const mx = (p1.pt.x + p2.pt.x) / 2;
  const my = (p1.pt.y + p2.pt.y) / 2;
  const angle = (Math.atan2(p2.pt.y - p1.pt.y, p2.pt.x - p1.pt.x) * 180) / Math.PI;
  const colName = (pc.comp.props.color ?? 'red').toLowerCase();
  const pal = LED_PALETTE[colName] ?? LED_PALETTE.red!;

  const dome = el('g', { transform: `translate(${num(mx)},${num(my)}) rotate(${num(angle)})` }, [
    el('path', {
      d: path(['M', 5.2, -5.0, 'L', 5.2, 5.0, 'A', 6.8, 6.8, 0, 1, 1, 5.2, -5.0, 'Z']),
      fill: pal.stroke,
      'fill-opacity': 0.85,
      stroke: '#212529',
      'stroke-width': 0.6,
    }),
    el('circle', { cx: -0.4, cy: 0, r: 4.8, fill: pal.fill }),
    el('circle', { cx: -2.0, cy: -1.6, r: 1.6, fill: pal.glow, 'fill-opacity': 0.8 }),
  ]);

  return [...drawLeads([p1, p2], mx, my), dome, pinAnchor(p1), pinAnchor(p2)];
}

function drawDisc(pc: PlacedComp): string[] {
  const [p1, p2] = pc.pins;
  if (!p1 || !p2) return [];
  const mx = (p1.pt.x + p2.pt.x) / 2;
  const my = (p1.pt.y + p2.pt.y) / 2;
  return [
    ...drawLeads([p1, p2], mx, my),
    el('ellipse', { cx: mx, cy: my, rx: 6.2, ry: 4.5, fill: '#f59f00', stroke: '#b45309', 'stroke-width': 0.8 }),
    el('ellipse', { cx: mx - 1.5, cy: my - 1.2, rx: 2, ry: 1.2, fill: '#ffe066', 'fill-opacity': 0.6 }),
    pinAnchor(p1),
    pinAnchor(p2),
  ];
}

function drawRadial(pc: PlacedComp): string[] {
  const [p1, p2] = pc.pins;
  if (!p1 || !p2) return [];
  const mx = (p1.pt.x + p2.pt.x) / 2;
  const my = (p1.pt.y + p2.pt.y) / 2;
  const angle = (Math.atan2(p2.pt.y - p1.pt.y, p2.pt.x - p1.pt.x) * 180) / Math.PI;
  const cap = el('g', { transform: `translate(${num(mx)},${num(my)}) rotate(${num(angle)})` }, [
    el('circle', { cx: 0, cy: 0, r: 6.4, fill: '#1e3a8a', stroke: '#0f172a', 'stroke-width': 0.8 }),
    el('path', { d: path(['M', 2.5, -5.8, 'A', 6.4, 6.4, 0, 0, 1, 2.5, 5.8, 'Z']), fill: '#cbd5e1' }),
    el('line', { x1: 4.2, y1: -2, x2: 4.2, y2: 2, stroke: '#1e293b', 'stroke-width': 1.1 }),
    el('circle', { cx: -1, cy: 0, r: 2.8, fill: '#94a3b8', 'fill-opacity': 0.45 }),
  ]);
  return [...drawLeads([p1, p2], mx, my), cap, pinAnchor(p1), pinAnchor(p2)];
}

function drawDip(pc: PlacedComp, labels: boolean): string[] {
  const pins = pc.pins;
  if (pins.length < 2) return [];
  const xs = pins.map(p => p.pt.x);
  const ys = pins.map(p => p.pt.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const bodyX = minX - 4.2;
  const bodyW = maxX - minX + 8.4;
  const bodyY = minY + 1.8;
  const bodyH = maxY - minY - 3.6;
  const midY = (minY + maxY) / 2;

  const out: string[] = [];
  for (const p of pins) {
    const legY = p.pt.y < midY ? p.pt.y : bodyY + bodyH;
    const legH = p.pt.y < midY ? bodyY - p.pt.y + 1 : p.pt.y - (bodyY + bodyH) + 1;
    out.push(
      el('rect', {
        x: p.pt.x - 1.6,
        y: legY,
        width: 3.2,
        height: Math.max(2, legH),
        fill: '#adb5bd',
        stroke: '#6c757d',
        'stroke-width': 0.4,
      }),
    );
  }

  out.push(
    el('rect', {
      x: bodyX,
      y: bodyY,
      width: bodyW,
      height: bodyH,
      rx: 2,
      fill: '#2b2f36',
      stroke: '#111317',
      'stroke-width': 0.9,
    }),
    el('path', {
      d: path(['M', bodyX, midY - 4.5, 'A', 4.5, 4.5, 0, 0, 1, bodyX, midY + 4.5]),
      fill: '#181a1f',
      stroke: '#495057',
      'stroke-width': 0.6,
    }),
    el('circle', { cx: bodyX + 4.5, cy: bodyY + 4.5, r: 1.4, fill: '#6c757d' }),
  );

  const chipLabel = pc.comp.part.toUpperCase();
  if (labels) {
    out.push(
      el('text', {
        x: (minX + maxX) / 2,
        y: midY - 1.5,
        'text-anchor': 'middle',
        fill: '#f8f9fa',
        'font-size': 5.2,
        'font-family': 'ui-monospace, Consolas, monospace',
        'font-weight': '700',
      }, pc.comp.ref),
      el('text', {
        x: (minX + maxX) / 2,
        y: midY + 4.8,
        'text-anchor': 'middle',
        fill: '#adb5bd',
        'font-size': 4.4,
        'font-family': 'ui-monospace, Consolas, monospace',
        'font-weight': '600',
      }, chipLabel),
    );
  } else {
    out.push(
      el('text', {
        x: (minX + maxX) / 2,
        y: midY + 2,
        'text-anchor': 'middle',
        fill: '#dee2e6',
        'font-size': 5.5,
        'font-family': 'ui-monospace, Consolas, monospace',
        'font-weight': '600',
      }, chipLabel),
    );
  }

  for (const p of pins) out.push(pinAnchor(p, 1.8));
  return out;
}

function drawTo92(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const cx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const cy = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length - 6;
  const out: string[] = [...drawLeads(pins, cx, cy)];
  out.push(
    el('path', {
      d: path(['M', cx - 6.5, cy + 2.5, 'L', cx + 6.5, cy + 2.5, 'A', 6.5, 6.5, 0, 1, 0, cx - 6.5, cy + 2.5, 'Z']),
      fill: '#2b2f36',
      stroke: '#111317',
      'stroke-width': 0.8,
    }),
    el('text', {
      x: cx,
      y: cy + 0.5,
      'text-anchor': 'middle',
      fill: '#cbd5e1',
      'font-size': 4.2,
      'font-family': 'ui-monospace, Consolas, monospace',
    }, pc.comp.part.toUpperCase()),
  );
  for (const p of pins) out.push(pinAnchor(p, 1.7));
  return out;
}

function drawButton(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const mx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const my = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length;
  const pressed = pc.comp.props.state === 'pressed';
  const out: string[] = [
    ...drawLeads(pins, mx, my),
    el('rect', { x: mx - 8, y: my - 8, width: 16, height: 16, rx: 2, fill: '#cbd5e1', stroke: '#64748b', 'stroke-width': 0.8 }),
    el('rect', { x: mx - 6.2, y: my - 6.2, width: 12.4, height: 12.4, rx: 1.5, fill: '#334155' }),
    el('circle', { cx: mx, cy: my, r: 4.4, fill: pressed ? '#e03131' : '#1e293b', stroke: '#94a3b8', 'stroke-width': 0.8 }),
  ];
  for (const p of pins) out.push(pinAnchor(p, 1.8));
  return out;
}

function drawSlideSwitch(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const mx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const my = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length;
  const closed = pc.comp.props.state === 'closed';
  const knobX = closed ? mx + 1.5 : mx - 5.5;
  const out: string[] = [
    ...drawLeads(pins, mx, my),
    el('rect', { x: mx - 10, y: my - 5.5, width: 20, height: 11, rx: 1.5, fill: '#94a3b8', stroke: '#475569', 'stroke-width': 0.8 }),
    el('rect', { x: mx - 7.5, y: my - 3.2, width: 15, height: 6.4, rx: 1, fill: '#1e293b' }),
    el('rect', { x: knobX, y: my - 2.8, width: 4.5, height: 5.6, rx: 0.8, fill: '#e2e8f0' }),
  ];
  for (const p of pins) out.push(pinAnchor(p, 1.8));
  return out;
}

function drawPot(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const mx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const my = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length - 5;
  const pos = Math.max(0, Math.min(1, Number(pc.comp.props.position ?? '0.5') || 0.5));
  const deg = -135 + pos * 270;
  const out: string[] = [
    ...drawLeads(pins, mx, my),
    el('rect', { x: mx - 9, y: my - 9, width: 18, height: 18, rx: 2, fill: '#1971c2', stroke: '#1864ab', 'stroke-width': 0.8 }),
    el('circle', { cx: mx, cy: my, r: 6.2, fill: '#f8f9fa', stroke: '#adb5bd', 'stroke-width': 0.7 }),
    el('g', { transform: `translate(${num(mx)},${num(my)}) rotate(${num(deg)})` }, [
      el('line', { x1: 0, y1: 0, x2: 0, y2: -5, stroke: '#1e293b', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
    ]),
  ];
  for (const p of pins) out.push(pinAnchor(p, 1.7));
  return out;
}

function drawBuzzer(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const mx = pins.reduce((s, p) => s + p.pt.x, 0) / pins.length;
  const my = pins.reduce((s, p) => s + p.pt.y, 0) / pins.length;
  const out: string[] = [
    ...drawLeads(pins, mx, my),
    el('circle', { cx: mx, cy: my, r: 9.5, fill: '#212529', stroke: '#0f172a', 'stroke-width': 0.9 }),
    el('circle', { cx: mx, cy: my, r: 6.5, fill: 'none', stroke: '#495057', 'stroke-width': 0.6 }),
    el('circle', { cx: mx, cy: my, r: 2.3, fill: '#0f172a' }),
    el('text', { x: mx - 5.5, y: my + 1.5, fill: '#dee2e6', 'font-size': 4.5, 'text-anchor': 'middle' }, '+'),
  ];
  for (const p of pins) out.push(pinAnchor(p, 1.8));
  return out;
}

function drawProbe(pc: PlacedComp): string[] {
  const p = pc.pins[0];
  if (!p) return [];
  return [
    el('circle', { cx: p.pt.x, cy: p.pt.y, r: 4.5, fill: '#7048e8', stroke: '#5f3dc4', 'stroke-width': 0.8 }),
    el('circle', { cx: p.pt.x, cy: p.pt.y, r: 1.8, fill: '#f8f9fa' }),
    pinAnchor(p, 1.8),
  ];
}

function drawBattery(pc: PlacedComp): string[] {
  const { x, y, w, h } = pc.box;
  const volt = pc.comp.props.voltage ?? pc.part?.props?.voltage?.default ?? '9';
  const vText = volt.endsWith('V') ? volt : `${volt}V`;
  const [pPlus, pMinus] = pc.pins;
  const out: string[] = [
    el('rect', { x, y, width: w, height: h, rx: 4, fill: '#262930', stroke: '#111317', 'stroke-width': 1 }),
    el('rect', { x, y, width: 18, height: h, rx: 3, fill: '#e67700' }),
    el('text', {
      x: x + w * 0.56,
      y: y + h * 0.54,
      'text-anchor': 'middle',
      fill: '#f8f9fa',
      'font-size': 8.5,
      'font-weight': '700',
      'font-family': 'ui-monospace, Consolas, monospace',
    }, vText),
  ];
  if (pPlus) {
    out.push(
      el('rect', { x: pPlus.pt.x - 4, y: pPlus.pt.y - 4, width: 7, height: 8, rx: 1.5, fill: '#e03131' }),
      el('text', { x: pPlus.pt.x - 7.5, y: pPlus.pt.y + 2, 'text-anchor': 'end', fill: '#ffa8a8', 'font-size': 7, 'font-weight': '700' }, '+'),
      pinAnchor(pPlus, 2.2),
    );
  }
  if (pMinus) {
    out.push(
      el('rect', { x: pMinus.pt.x - 4, y: pMinus.pt.y - 4, width: 7, height: 8, rx: 1.5, fill: '#495057' }),
      el('text', { x: pMinus.pt.x - 7.5, y: pMinus.pt.y + 2, 'text-anchor': 'end', fill: '#ced4da', 'font-size': 7, 'font-weight': '700' }, '-'),
      pinAnchor(pMinus, 2.2),
    );
  }
  return out;
}

function drawSupply(pc: PlacedComp): string[] {
  const { x, y, w, h } = pc.box;
  const volt = pc.comp.props.voltage ?? pc.part?.props?.voltage?.default ?? '5';
  const vText = volt.endsWith('V') ? volt : `${volt}V`;
  const [pPlus, pMinus] = pc.pins;
  const out: string[] = [
    el('rect', { x, y, width: w, height: h, rx: 4, fill: '#343a40', stroke: '#1b1d21', 'stroke-width': 1 }),
    el('rect', { x: x + 7, y: y + 10, width: 38, height: 22, rx: 2, fill: '#0b2e13', stroke: '#198754', 'stroke-width': 0.8 }),
    el('text', {
      x: x + 26,
      y: y + 24,
      'text-anchor': 'middle',
      fill: '#69db7c',
      'font-size': 8.5,
      'font-weight': '700',
      'font-family': 'ui-monospace, Consolas, monospace',
    }, vText),
  ];
  if (pPlus) {
    out.push(
      el('circle', { cx: pPlus.pt.x - 2, cy: pPlus.pt.y, r: 4, fill: '#e03131', stroke: '#fff', 'stroke-width': 0.6 }),
      pinAnchor(pPlus, 2.2),
    );
  }
  if (pMinus) {
    out.push(
      el('circle', { cx: pMinus.pt.x - 2, cy: pMinus.pt.y, r: 4, fill: '#212529', stroke: '#adb5bd', 'stroke-width': 0.6 }),
      pinAnchor(pMinus, 2.2),
    );
  }
  return out;
}

function drawArduinoUno(pc: PlacedComp): string[] {
  const { x, y, w, h } = pc.box;
  const out: string[] = [
    el('rect', { x, y, width: w, height: h, rx: 5, fill: '#00979c', stroke: '#006d71', 'stroke-width': 1.2 }),
    el('rect', { x: x - 6, y: y + 22, width: 32, height: 34, rx: 2, fill: '#ced4da', stroke: '#868e96', 'stroke-width': 0.8 }),
    el('rect', { x: x - 4, y: y + h - 46, width: 34, height: 28, rx: 2, fill: '#212529' }),
    el('rect', { x: x + 78, y: y + h * 0.56, width: 96, height: 26, rx: 2, fill: '#212529' }),
    el('text', {
      x: x + w * 0.56,
      y: y + h * 0.42,
      'text-anchor': 'middle',
      fill: '#ffffff',
      'font-size': 11,
      'font-weight': '700',
      'font-family': 'ui-monospace, Consolas, monospace',
    }, 'ARDUINO UNO'),
    el('rect', { x: x + 24, y: y + 2, width: 184, height: 12, rx: 1.5, fill: '#1e2024' }),
    el('rect', { x: x + 54, y: y + h - 14, width: 134, height: 12, rx: 1.5, fill: '#1e2024' }),
  ];
  for (const p of pc.pins) {
    out.push(
      el('rect', { x: p.pt.x - 2.3, y: p.pt.y - 2.3, width: 4.6, height: 4.6, rx: 0.6, fill: '#343a40', stroke: '#adb5bd', 'stroke-width': 0.5 }),
      pinAnchor(p, 1.8),
    );
  }
  return out;
}

function drawGenericHeader(pc: PlacedComp): string[] {
  const pins = pc.pins;
  if (pins.length === 0) return [];
  const xs = pins.map(p => p.pt.x);
  const ys = pins.map(p => p.pt.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const out: string[] = [
    el('rect', {
      x: minX - 4.5,
      y: minY - 4.5,
      width: maxX - minX + 9,
      height: maxY - minY + 9,
      rx: 2,
      fill: '#495057',
      stroke: '#212529',
      'stroke-width': 0.8,
    }),
  ];
  for (const p of pins) out.push(pinAnchor(p, 2));
  return out;
}

export function drawPlacedComponent(
  _q: Query,
  pc: PlacedComp,
  highlighted: boolean,
  labels: boolean,
  labelSvg?: string,
): string {
  let children: string[];
  switch (pc.family) {
    case 'axial':
      children = drawAxial(pc);
      break;
    case 'led':
      children = drawLed(pc);
      break;
    case 'disc':
      children = drawDisc(pc);
      break;
    case 'radial':
      children = drawRadial(pc);
      break;
    case 'dip':
      children = drawDip(pc, labels);
      break;
    case 'to92':
      children = drawTo92(pc);
      break;
    case 'button':
      children = drawButton(pc);
      break;
    case 'slide_switch':
      children = drawSlideSwitch(pc);
      break;
    case 'pot':
      children = drawPot(pc);
      break;
    case 'buzzer':
      children = drawBuzzer(pc);
      break;
    case 'probe':
      children = drawProbe(pc);
      break;
    case 'battery':
      children = drawBattery(pc);
      break;
    case 'supply':
      children = drawSupply(pc);
      break;
    case 'arduino_uno':
      children = drawArduinoUno(pc);
      break;
    default:
      children = drawGenericHeader(pc);
      break;
  }

  if (labelSvg) children.push(labelSvg);

  if (highlighted) {
    children.unshift(
      el('rect', {
        x: pc.box.x - 2,
        y: pc.box.y - 2,
        width: pc.box.w + 4,
        height: pc.box.h + 4,
        rx: 4,
        class: 'bb-hl-box',
      }),
    );
  }

  return el('g', {
    'data-ref': pc.comp.ref,
    class: highlighted ? 'bb-part hl' : 'bb-part',
  }, children);
}
