// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Query } from '@cadllm/core';
import {
  componentFootprintName,
  footprint,
  isPcbPart,
  pads as resolvePads,
  parsePcbPlace,
  type Footprint,
  type PadInstance,
  type PcbPlace,
  type Point,
  type SilkShape,
} from '@cadllm/pcb';

export interface ExportOptions {
  /** Override project filename prefix (defaults to `meta.name` or `"board"`). */
  projectName?: string;
  /** Optional pre-resolved pad instances (useful for unit tests). */
  pads?: PadInstance[];
  /** Optional pre-resolved footprint definitions keyed by footprint name (useful for unit tests). */
  footprints?: Record<string, Footprint>;
}

const MASK_EXPANSION = 0.05; // mm per side (+0.1 mm total width/height)
const DEFAULT_SILK_WIDTH = 0.15;
const OUTLINE_WIDTH = 0.1;

export function projectName(q: Query, opts?: ExportOptions): string {
  const raw = (opts?.projectName ?? q.circuit.meta.name ?? 'board').trim();
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'board';
}

const fmt6 = (n: number): string => {
  const v = Math.abs(n) < 1e-9 ? 0 : n;
  return v.toFixed(6);
};

/** Format a millimetre coordinate into Gerber 4.6 integer units (1e-6 mm). */
export function fmtCoord(mm: number): string {
  const v = Math.round(mm * 1e6);
  return Object.is(v, -0) || v === 0 ? '0' : String(v);
}

const normRot = (deg: number): number => {
  const r = ((deg % 360) + 360) % 360;
  return Math.abs(r) < 1e-6 || Math.abs(r - 360) < 1e-6 ? 0 : r;
};

interface ApertureEntry {
  code: number;
  macroDef?: string;
  toolDef: string;
}

class ApertureTable {
  private nextCode = 10;
  private byKey = new Map<string, ApertureEntry>();
  private entries: ApertureEntry[] = [];

  circle(diameter: number): number {
    const d = fmt6(Math.max(diameter, 0.001));
    const key = `C:${d}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.code;
    const code = this.nextCode++;
    const entry: ApertureEntry = { code, toolDef: `%ADD${code}C,${d}*%` };
    this.byKey.set(key, entry);
    this.entries.push(entry);
    return code;
  }

  rect(width: number, height: number, rotDeg = 0): number {
    const r = normRot(rotDeg);
    if (Math.abs(r) < 1e-6 || Math.abs(r - 180) < 1e-6) {
      return this.stdRect(width, height);
    }
    if (Math.abs(r - 90) < 1e-6 || Math.abs(r - 270) < 1e-6) {
      return this.stdRect(height, width);
    }
    const w = fmt6(width);
    const h = fmt6(height);
    const a = fmt6(r);
    const key = `ROTR:${w}:${h}:${a}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.code;
    const code = this.nextCode++;
    const mName = `RECT${code}`;
    const macroDef = [
      `%AM${mName}*`,
      `21,1,${w},${h},0.000000,0.000000,${a}*`,
      '%',
    ].join('\n');
    const entry: ApertureEntry = { code, macroDef, toolDef: `%ADD${code}${mName}*%` };
    this.byKey.set(key, entry);
    this.entries.push(entry);
    return code;
  }

  private stdRect(width: number, height: number): number {
    const w = fmt6(width);
    const h = fmt6(height);
    const key = `R:${w}X${h}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.code;
    const code = this.nextCode++;
    const entry: ApertureEntry = { code, toolDef: `%ADD${code}R,${w}X${h}*%` };
    this.byKey.set(key, entry);
    this.entries.push(entry);
    return code;
  }

  oval(width: number, height: number, rotDeg = 0): number {
    const r = normRot(rotDeg);
    if (Math.abs(r) < 1e-6 || Math.abs(r - 180) < 1e-6) {
      return this.stdOval(width, height);
    }
    if (Math.abs(r - 90) < 1e-6 || Math.abs(r - 270) < 1e-6) {
      return this.stdOval(height, width);
    }
    return this.roundRect(width, height, 0.5, r);
  }

  private stdOval(width: number, height: number): number {
    const w = fmt6(width);
    const h = fmt6(height);
    const key = `O:${w}X${h}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.code;
    const code = this.nextCode++;
    const entry: ApertureEntry = { code, toolDef: `%ADD${code}O,${w}X${h}*%` };
    this.byKey.set(key, entry);
    this.entries.push(entry);
    return code;
  }

  roundRect(width: number, height: number, radiusRatio = 0.25, rotDeg = 0): number {
    let wNum = width;
    let hNum = height;
    let r = normRot(rotDeg);
    if (Math.abs(r - 180) < 1e-6) {
      r = 0;
    } else if (Math.abs(r - 90) < 1e-6 || Math.abs(r - 270) < 1e-6) {
      wNum = height;
      hNum = width;
      r = 0;
    }
    const clampedRatio = Math.min(Math.max(radiusRatio, 0), 0.5);
    const rad = Math.min(wNum, hNum) * clampedRatio;
    if (rad <= 1e-6) return this.rect(wNum, hNum, r);
    if (Math.abs(wNum - hNum) < 1e-6 && Math.abs(rad - wNum / 2) < 1e-6) {
      return this.circle(wNum);
    }

    const w = fmt6(wNum);
    const h = fmt6(hNum);
    const radStr = fmt6(rad);
    const a = fmt6(r);
    const key = `RR:${w}:${h}:${radStr}:${a}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.code;

    const code = this.nextCode++;
    const mName = `RR${code}`;
    const primitives: string[] = [];
    const innerH = hNum - 2 * rad;
    const innerW = wNum - 2 * rad;
    if (innerH > 1e-6) {
      primitives.push(`21,1,${w},${fmt6(innerH)},0.000000,0.000000,${a}*`);
    }
    if (innerW > 1e-6) {
      primitives.push(`21,1,${fmt6(innerW)},${h},0.000000,0.000000,${a}*`);
    }
    const dx = wNum / 2 - rad;
    const dy = hNum / 2 - rad;
    const dStr = fmt6(2 * rad);
    const corners: [number, number][] = [
      [-dx, -dy],
      [dx, -dy],
      [dx, dy],
      [-dx, dy],
    ];
    const seenCorner = new Set<string>();
    for (const [cx, cy] of corners) {
      const cxStr = fmt6(cx);
      const cyStr = fmt6(cy);
      const ck = `${cxStr},${cyStr}`;
      if (seenCorner.has(ck)) continue;
      seenCorner.add(ck);
      primitives.push(`1,1,${dStr},${cxStr},${cyStr},${a}*`);
    }

    const macroDef = [`%AM${mName}*`, ...primitives, '%'].join('\n');
    const entry: ApertureEntry = { code, macroDef, toolDef: `%ADD${code}${mName}*%` };
    this.byKey.set(key, entry);
    this.entries.push(entry);
    return code;
  }

  forPad(pad: PadInstance, expandMm = 0): number {
    const w = pad.size[0] + expandMm * 2;
    const h = pad.size[1] + expandMm * 2;
    switch (pad.shape) {
      case 'circle':
        return this.circle(w);
      case 'rect':
        return this.rect(w, h, pad.rot);
      case 'oval':
        return this.oval(w, h, pad.rot);
      case 'roundrect':
        return this.roundRect(w, h, pad.roundRadius ?? 0.25, pad.rot);
    }
  }

  headerLines(): string[] {
    const macros: string[] = [];
    const tools: string[] = [];
    for (const e of this.entries) {
      if (e.macroDef) macros.push(e.macroDef);
      tools.push(e.toolDef);
    }
    return [...macros, ...tools];
  }
}

function transformSilkPoint(pt: Point, place: PcbPlace): Point {
  const mx = place.side === 'bottom' ? -pt[0] : pt[0];
  const my = pt[1];
  const rad = (place.rot * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [place.x + mx * c - my * s, place.y + mx * s + my * c];
}

function silkShapePolylines(shape: SilkShape, place: PcbPlace): { width: number; points: Point[] }[] {
  const width = shape.width ?? DEFAULT_SILK_WIDTH;
  switch (shape.kind) {
    case 'line':
      return [{ width, points: [transformSilkPoint(shape.from, place), transformSilkPoint(shape.to, place)] }];
    case 'rect': {
      const [cx, cy] = shape.at;
      const hw = shape.size[0] / 2;
      const hh = shape.size[1] / 2;
      const p0 = transformSilkPoint([cx - hw, cy - hh], place);
      const p1 = transformSilkPoint([cx + hw, cy - hh], place);
      const p2 = transformSilkPoint([cx + hw, cy + hh], place);
      const p3 = transformSilkPoint([cx - hw, cy + hh], place);
      return [{ width, points: [p0, p1, p2, p3, p0] }];
    }
    case 'poly': {
      if (shape.points.length < 2) return [];
      const pts = shape.points.map(pt => transformSilkPoint(pt, place));
      if (shape.closed && (pts[0]![0] !== pts[pts.length - 1]![0] || pts[0]![1] !== pts[pts.length - 1]![1])) {
        pts.push(pts[0]!);
      }
      return [{ width, points: pts }];
    }
    case 'circle': {
      const steps = 24;
      const pts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push(transformSilkPoint([shape.at[0] + shape.r * Math.cos(a), shape.at[1] + shape.r * Math.sin(a)], place));
      }
      return [{ width, points: pts }];
    }
    case 'arc': {
      const delta = shape.endDeg - shape.startDeg;
      const steps = Math.max(8, Math.ceil((Math.abs(delta) / 360) * 24));
      const pts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const deg = shape.startDeg + (delta * i) / steps;
        const rad = (deg * Math.PI) / 180;
        pts.push(transformSilkPoint([shape.at[0] + shape.r * Math.cos(rad), shape.at[1] + shape.r * Math.sin(rad)], place));
      }
      return [{ width, points: pts }];
    }
  }
}

function resolveBoardOutline(q: Query, padList: PadInstance[]): Point[] {
  const explicit = q.circuit.pcb?.board?.outline;
  if (explicit && explicit.length >= 3) return explicit;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expand = (x: number, y: number, r = 0) => {
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  };
  for (const p of padList) expand(p.at[0], p.at[1], Math.max(p.size[0], p.size[1]) / 2);
  for (const t of q.circuit.pcb?.tracks ?? []) {
    for (const [x, y] of t.points) expand(x, y, t.width / 2);
  }
  for (const v of q.circuit.pcb?.vias ?? []) expand(v.at[0], v.at[1], v.size / 2);

  if (!Number.isFinite(minX)) {
    return [[0, 0], [30, 0], [30, 20], [0, 20]];
  }
  const margin = 2;
  const x0 = Math.min(0, Math.floor(minX - margin));
  const y0 = Math.min(0, Math.floor(minY - margin));
  const x1 = Math.ceil(maxX + margin);
  const y1 = Math.ceil(maxY + margin);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function formatGerberFile(
  fileFunction: string,
  polarity: 'Positive' | 'Negative',
  apertures: ApertureTable,
  body: string[],
): string {
  const lines = [
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%TF.GenerationSoftware,CadLLM,export,0.0.0*%',
    '%TF.SameCoordinates,Original*%',
    `%TF.FileFunction,${fileFunction}*%`,
    `%TF.FilePolarity,${polarity}*%`,
    '%LPD*%',
    'G01*',
    'G75*',
    ...apertures.headerLines(),
    ...body,
    'M02*',
  ];
  return `${lines.join('\n')}\n`;
}

function buildCopperLayer(
  q: Query,
  layer: 'F' | 'B',
  padList: PadInstance[],
): string {
  const apertures = new ApertureTable();
  const body: string[] = [];
  let currentTool = -1;
  const selectTool = (code: number) => {
    if (currentTool !== code) {
      body.push(`D${code}*`);
      currentTool = code;
    }
  };

  const layerPads = padList
    .filter(p => p.layers === 'TH' || p.layers === layer)
    .sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.pinId, b.pinId));

  for (const pad of layerPads) {
    const code = apertures.forPad(pad, 0);
    selectTool(code);
    body.push(`X${fmtCoord(pad.at[0])}Y${fmtCoord(pad.at[1])}D03*`);
  }

  const vias = q.circuit.pcb?.vias ?? [];
  for (const via of vias) {
    const code = apertures.circle(via.size);
    selectTool(code);
    body.push(`X${fmtCoord(via.at[0])}Y${fmtCoord(via.at[1])}D03*`);
  }

  const tracks = (q.circuit.pcb?.tracks ?? []).filter(t => t.layer === layer && t.points.length >= 2);
  for (const track of tracks) {
    const code = apertures.circle(track.width);
    selectTool(code);
    const [p0, ...rest] = track.points;
    body.push(`X${fmtCoord(p0![0])}Y${fmtCoord(p0![1])}D02*`);
    for (const pt of rest) {
      body.push(`X${fmtCoord(pt[0])}Y${fmtCoord(pt[1])}D01*`);
    }
  }

  const fn = layer === 'F' ? 'Copper,L1,Top' : 'Copper,L2,Bot';
  return formatGerberFile(fn, 'Positive', apertures, body);
}

function buildMaskLayer(layer: 'F' | 'B', padList: PadInstance[]): string {
  const apertures = new ApertureTable();
  const body: string[] = [];
  let currentTool = -1;
  const selectTool = (code: number) => {
    if (currentTool !== code) {
      body.push(`D${code}*`);
      currentTool = code;
    }
  };

  const layerPads = padList
    .filter(p => p.layers === 'TH' || p.layers === layer)
    .sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.pinId, b.pinId));

  for (const pad of layerPads) {
    const code = apertures.forPad(pad, MASK_EXPANSION);
    selectTool(code);
    body.push(`X${fmtCoord(pad.at[0])}Y${fmtCoord(pad.at[1])}D03*`);
  }

  const fn = layer === 'F' ? 'Soldermask,Top' : 'Soldermask,Bot';
  return formatGerberFile(fn, 'Negative', apertures, body);
}

function buildSilkLayer(
  q: Query,
  side: 'top' | 'bottom',
  opts?: ExportOptions,
): string {
  const apertures = new ApertureTable();
  const body: string[] = [];
  let currentTool = -1;
  const selectTool = (code: number) => {
    if (currentTool !== code) {
      body.push(`D${code}*`);
      currentTool = code;
    }
  };

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const place = parsePcbPlace(comp.place.pcb);
    if (!place || place.side !== side) continue;
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    let fp: Footprint | undefined = opts?.footprints?.[fpName];
    if (!fp) {
      try {
        fp = footprint(fpName);
      } catch {
        continue;
      }
    }
    for (const shape of fp.silk) {
      for (const poly of silkShapePolylines(shape, place)) {
        if (poly.points.length < 2) continue;
        const code = apertures.circle(poly.width);
        selectTool(code);
        const [p0, ...rest] = poly.points;
        body.push(`X${fmtCoord(p0![0])}Y${fmtCoord(p0![1])}D02*`);
        for (const pt of rest) {
          body.push(`X${fmtCoord(pt[0])}Y${fmtCoord(pt[1])}D01*`);
        }
      }
    }
  }

  const fn = side === 'top' ? 'Legend,Top' : 'Legend,Bot';
  return formatGerberFile(fn, 'Positive', apertures, body);
}

function buildEdgeCutsLayer(q: Query, padList: PadInstance[]): string {
  const apertures = new ApertureTable();
  const body: string[] = [];
  const outline = resolveBoardOutline(q, padList);
  if (outline.length >= 3) {
    const code = apertures.circle(OUTLINE_WIDTH);
    body.push(`D${code}*`);
    const p0 = outline[0]!;
    body.push(`X${fmtCoord(p0[0])}Y${fmtCoord(p0[1])}D02*`);
    for (let i = 1; i < outline.length; i++) {
      const pt = outline[i]!;
      body.push(`X${fmtCoord(pt[0])}Y${fmtCoord(pt[1])}D01*`);
    }
    const last = outline[outline.length - 1]!;
    if (last[0] !== p0[0] || last[1] !== p0[1]) {
      body.push(`X${fmtCoord(p0[0])}Y${fmtCoord(p0[1])}D01*`);
    }
  }
  return formatGerberFile('Profile,NP', 'Positive', apertures, body);
}

/** Generate RS-274X Gerbers (with X2 attributes) keyed by `<project>-<layer>.gbr` filename. */
export function gerbers(q: Query, opts?: ExportOptions): Record<string, string> {
  const proj = projectName(q, opts);
  const padList = opts?.pads ?? resolvePads(q);
  return {
    [`${proj}-F_Cu.gbr`]: buildCopperLayer(q, 'F', padList),
    [`${proj}-B_Cu.gbr`]: buildCopperLayer(q, 'B', padList),
    [`${proj}-F_Mask.gbr`]: buildMaskLayer('F', padList),
    [`${proj}-B_Mask.gbr`]: buildMaskLayer('B', padList),
    [`${proj}-F_Silkscreen.gbr`]: buildSilkLayer(q, 'top', opts),
    [`${proj}-B_Silkscreen.gbr`]: buildSilkLayer(q, 'bottom', opts),
    [`${proj}-Edge_Cuts.gbr`]: buildEdgeCutsLayer(q, padList),
  };
}
