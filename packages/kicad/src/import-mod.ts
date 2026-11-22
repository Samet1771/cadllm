// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Footprint, PadDef, PadLayers, PadShape, Point, SilkShape } from '@cadllm/pcb';
import {
  atomNumber,
  atomString,
  findChild,
  findChildren,
  headOf,
  num,
  parseSexpr,
  printSexpr,
  str,
  sym,
  type Sexpr,
  type SexprList,
} from './sexpr.ts';

export interface ImportedFootprint extends Footprint {
  warnings: string[];
}

export interface ImportKicadModOptions {
  warnings?: string[];
}

export const roundMm = (n: number): number => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
};

const KNOWN_META_TAGS = new Set([
  'version',
  'generator',
  'generator_version',
  'layer',
  'tedit',
  'tstamp',
  'uuid',
  'at',
  'descr',
  'tags',
  'path',
  'attr',
  'property',
  'fp_text',
  'solder_mask_margin',
  'solder_paste_margin',
  'solder_paste_ratio',
  'clearance',
  'zone_connect',
  'autoplace_cost90',
  'autoplace_cost180',
  'private_layers',
  'net_tie_pad_groups',
  'embedded_fonts',
]);

const GRAPHIC_TAGS = new Set(['fp_line', 'fp_circle', 'fp_arc', 'fp_rect', 'fp_poly']);
const PAD_SHAPES = new Set<PadShape>(['circle', 'rect', 'oval', 'roundrect']);

const isSilkLayer = (layer: string | undefined): boolean =>
  layer === 'F.SilkS' || layer === 'F.Silkscreen';

const isCourtyardLayer = (layer: string | undefined): boolean =>
  layer === 'F.CrtYd' || layer === 'F.Courtyard' || layer === 'B.CrtYd' || layer === 'B.Courtyard';

function extractLayer(item: SexprList): string | undefined {
  const lNode = findChild(item, 'layer');
  return lNode ? atomString(lNode[1]) : undefined;
}

function extractWidth(item: SexprList): number | undefined {
  const wNode = findChild(item, 'width');
  if (wNode) {
    const w = atomNumber(wNode[1]);
    if (w !== undefined && w > 0) return roundMm(w);
  }
  const stroke = findChild(item, 'stroke');
  if (stroke) {
    const sw = findChild(stroke, 'width');
    if (sw) {
      const w = atomNumber(sw[1]);
      if (w !== undefined && w > 0) return roundMm(w);
    }
  }
  return undefined;
}

function readXY(item: SexprList, tag: string): Point | undefined {
  const node = findChild(item, tag);
  if (!node) return undefined;
  const x = atomNumber(node[1]);
  const y = atomNumber(node[2]);
  if (x === undefined || y === undefined) return undefined;
  return [roundMm(x), roundMm(y)];
}

function parseArcFrom3Points(s: Point, m: Point, e: Point, width?: number): SilkShape | undefined {
  const [x1, y1] = s;
  const [x2, y2] = m;
  const [x3, y3] = e;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) {
    return { kind: 'line', from: s, to: e, ...(width !== undefined ? { width } : {}) };
  }
  const u1 = x1 * x1 + y1 * y1;
  const u2 = x2 * x2 + y2 * y2;
  const u3 = x3 * x3 + y3 * y3;
  const cx = (u1 * (y2 - y3) + u2 * (y3 - y1) + u3 * (y1 - y2)) / d;
  const cy = (u1 * (x3 - x2) + u2 * (x1 - x3) + u3 * (x2 - x1)) / d;
  const r = Math.hypot(x1 - cx, y1 - cy);

  const normDeg = (rad: number): number => (((rad * 180) / Math.PI) % 360 + 360) % 360;
  const aS = normDeg(Math.atan2(y1 - cy, x1 - cx));
  const aM = normDeg(Math.atan2(y2 - cy, x2 - cx));
  const aE = normDeg(Math.atan2(y3 - cy, x3 - cx));

  const cwSE = (aE - aS + 360) % 360;
  const cwSM = (aM - aS + 360) % 360;

  let startDeg: number;
  let endDeg: number;
  if (cwSM <= cwSE) {
    startDeg = aS;
    endDeg = aS + cwSE;
  } else {
    const cwES = (aS - aE + 360) % 360;
    startDeg = aE;
    endDeg = aE + cwES;
  }

  return {
    kind: 'arc',
    at: [roundMm(cx), roundMm(cy)],
    r: roundMm(r),
    startDeg: roundMm(startDeg),
    endDeg: roundMm(endDeg),
    ...(width !== undefined ? { width } : {}),
  };
}

function parseGraphic(item: SexprList, tag: string): { silk?: SilkShape; bboxPoints: Point[] } {
  const width = extractWidth(item);
  const bboxPoints: Point[] = [];

  if (tag === 'fp_line') {
    const from = readXY(item, 'start');
    const to = readXY(item, 'end');
    if (!from || !to) return { bboxPoints };
    bboxPoints.push(from, to);
    return {
      silk: { kind: 'line', from, to, ...(width !== undefined ? { width } : {}) },
      bboxPoints,
    };
  }

  if (tag === 'fp_rect') {
    const start = readXY(item, 'start');
    const end = readXY(item, 'end');
    if (!start || !end) return { bboxPoints };
    bboxPoints.push(start, end);
    const minX = roundMm(Math.min(start[0], end[0]));
    const minY = roundMm(Math.min(start[1], end[1]));
    const w = roundMm(Math.abs(end[0] - start[0]));
    const h = roundMm(Math.abs(end[1] - start[1]));
    return {
      silk: { kind: 'rect', at: [minX, minY], size: [w, h], ...(width !== undefined ? { width } : {}) },
      bboxPoints,
    };
  }

  if (tag === 'fp_circle') {
    const center = readXY(item, 'center');
    const end = readXY(item, 'end');
    if (!center || !end) return { bboxPoints };
    const r = roundMm(Math.hypot(end[0] - center[0], end[1] - center[1]));
    bboxPoints.push([roundMm(center[0] - r), roundMm(center[1] - r)], [roundMm(center[0] + r), roundMm(center[1] + r)]);
    return {
      silk: { kind: 'circle', at: center, r, ...(width !== undefined ? { width } : {}) },
      bboxPoints,
    };
  }

  if (tag === 'fp_arc') {
    const start = readXY(item, 'start');
    const mid = readXY(item, 'mid');
    const end = readXY(item, 'end');
    if (start && mid && end) {
      bboxPoints.push(start, mid, end);
      const silk = parseArcFrom3Points(start, mid, end, width);
      return { ...(silk ? { silk } : {}), bboxPoints };
    }
    const angleNode = findChild(item, 'angle');
    const angle = angleNode ? atomNumber(angleNode[1]) : undefined;
    if (start && end && angle !== undefined) {
      const cx = start[0];
      const cy = start[1];
      const r = roundMm(Math.hypot(end[0] - cx, end[1] - cy));
      const a0 = (((Math.atan2(end[1] - cy, end[0] - cx) * 180) / Math.PI) % 360 + 360) % 360;
      const a1 = a0 + angle;
      const startDeg = roundMm(Math.min(a0, a1));
      const endDeg = roundMm(Math.max(a0, a1));
      bboxPoints.push([roundMm(cx - r), roundMm(cy - r)], [roundMm(cx + r), roundMm(cy + r)]);
      return {
        silk: { kind: 'arc', at: [cx, cy], r, startDeg, endDeg, ...(width !== undefined ? { width } : {}) },
        bboxPoints,
      };
    }
    return { bboxPoints };
  }

  if (tag === 'fp_poly') {
    const ptsNode = findChild(item, 'pts');
    if (!ptsNode) return { bboxPoints };
    const xyNodes = findChildren(ptsNode, 'xy');
    const points: Point[] = [];
    for (const xy of xyNodes) {
      const x = atomNumber(xy[1]);
      const y = atomNumber(xy[2]);
      if (x !== undefined && y !== undefined) {
        const pt: Point = [roundMm(x), roundMm(y)];
        points.push(pt);
        bboxPoints.push(pt);
      }
    }
    if (points.length === 0) return { bboxPoints };
    return {
      silk: { kind: 'poly', points, closed: true, ...(width !== undefined ? { width } : {}) },
      bboxPoints,
    };
  }

  return { bboxPoints };
}

function mapPadLayers(padType: string, layerNames: string[], warnings: string[], padId: string): PadLayers {
  if (padType === 'thru_hole' || padType === 'np_thru_hole') return 'TH';
  const hasWildcardCu = layerNames.some(l => l === '*.Cu' || l === 'F&B.Cu');
  const hasFCu = layerNames.includes('F.Cu');
  const hasBCu = layerNames.includes('B.Cu');
  if (hasWildcardCu || (hasFCu && hasBCu)) return 'TH';
  if (hasBCu) return 'B';
  if (hasFCu) return 'F';
  if (layerNames.some(l => l.startsWith('B.'))) return 'B';
  if (layerNames.length > 0 && !layerNames.some(l => l.startsWith('F.'))) {
    warnings.push(`Pad "${padId}" has non-copper layers [${layerNames.join(', ')}]; defaulting to F`);
  }
  return 'F';
}

function parsePad(item: SexprList, warnings: string[]): PadDef | undefined {
  const id = atomString(item[1]) ?? '';
  const padType = atomString(item[2]);
  const rawShape = atomString(item[3]);

  if (!padType || (padType !== 'thru_hole' && padType !== 'smd' && padType !== 'np_thru_hole')) {
    warnings.push(`Ignored pad "${id}" with unsupported type "${padType ?? 'unknown'}"`);
    return undefined;
  }

  let shape: PadShape = 'rect';
  if (rawShape && PAD_SHAPES.has(rawShape as PadShape)) {
    shape = rawShape as PadShape;
  } else {
    warnings.push(`Pad "${id}" has unsupported shape "${rawShape ?? 'unknown'}"; falling back to "rect"`);
  }

  const atNode = findChild(item, 'at');
  const x = roundMm(atNode ? (atomNumber(atNode[1]) ?? 0) : 0);
  const y = roundMm(atNode ? (atomNumber(atNode[2]) ?? 0) : 0);
  const rotRaw = atNode ? (atomNumber(atNode[3]) ?? 0) : 0;
  const rotMod180 = ((rotRaw % 180) + 180) % 180;

  const sizeNode = findChild(item, 'size');
  const rawW = roundMm(sizeNode ? (atomNumber(sizeNode[1]) ?? 0) : 0);
  const rawH = roundMm(sizeNode ? (atomNumber(sizeNode[2]) ?? rawW) : 0);

  let size: [number, number] = [rawW, rawH];
  if (Math.abs(rotMod180 - 90) < 1e-3) {
    size = [rawH, rawW];
  } else if (Math.abs(rotMod180) > 1e-3) {
    warnings.push(`Pad "${id}" non-orthogonal rotation ${rotRaw}deg cannot be baked into axis-aligned PadDef.size`);
  }

  const layersNode = findChild(item, 'layers');
  const layerNames: string[] = [];
  if (layersNode) {
    for (let i = 1; i < layersNode.length; i++) {
      const s = atomString(layersNode[i]);
      if (s) layerNames.push(s);
    }
  }
  const layers = mapPadLayers(padType, layerNames, warnings, id);

  let drill: number | undefined;
  const drillNode = findChild(item, 'drill');
  if (drillNode) {
    const firstTok = atomString(drillNode[1]);
    if (firstTok === 'oval') {
      const dw = atomNumber(drillNode[2]) ?? 0;
      const dh = atomNumber(drillNode[3]) ?? dw;
      drill = roundMm(Math.min(dw, dh));
      warnings.push(
        `Pad "${id}" uses oval drill (${roundMm(dw)}x${roundMm(dh)} mm); approximated as circular drill ${drill} mm`,
      );
    } else {
      const d = atomNumber(drillNode[1]);
      if (d !== undefined && d > 0) drill = roundMm(d);
    }
    if (findChild(drillNode, 'offset')) {
      warnings.push(`Pad "${id}" drill offset is not supported and was ignored`);
    }
  } else if (padType === 'np_thru_hole') {
    drill = roundMm(Math.min(size[0], size[1]));
  }

  let roundRadius: number | undefined;
  if (shape === 'roundrect') {
    const rrNode = findChild(item, 'roundrect_rratio');
    const rr = rrNode ? atomNumber(rrNode[1]) : undefined;
    roundRadius = roundMm(rr ?? 0.25);
  }

  const pad: PadDef = {
    id,
    shape,
    at: [x, y],
    size,
    ...(drill !== undefined ? { drill } : {}),
    layers,
    ...(roundRadius !== undefined ? { roundRadius } : {}),
  };
  return pad;
}

/** Parse a KiCad 6–9 `.kicad_mod` (`footprint` or legacy `module`) S-expression into a CadLLM Footprint. */
export function importKicadMod(
  text: string,
  opts?: ImportKicadModOptions | string[],
): ImportedFootprint {
  const root = parseSexpr(text);
  const rootTag = headOf(root);
  if (!Array.isArray(root) || (rootTag !== 'footprint' && rootTag !== 'module')) {
    throw new Error('Invalid .kicad_mod: expected (footprint ...) or (module ...) root');
  }

  const name = atomString(root[1]) ?? 'footprint';
  const warnings: string[] = [];
  const pads: PadDef[] = [];
  const silk: SilkShape[] = [];
  const crtPoints: Point[] = [];
  const fallbackPoints: Point[] = [];

  for (let i = 2; i < root.length; i++) {
    const child = root[i];
    if (!Array.isArray(child)) {
      const val = atomString(child);
      if (val && val !== 'locked' && val !== 'placed') {
        warnings.push(`Ignored unexpected atom "${val}" in footprint`);
      }
      continue;
    }

    const tag = headOf(child);
    if (!tag) {
      warnings.push('Ignored untagged list in footprint');
      continue;
    }

    if (KNOWN_META_TAGS.has(tag)) continue;

    if (tag === 'pad') {
      const pad = parsePad(child, warnings);
      if (pad) {
        pads.push(pad);
        const hw = pad.size[0] / 2;
        const hh = pad.size[1] / 2;
        fallbackPoints.push(
          [roundMm(pad.at[0] - hw), roundMm(pad.at[1] - hh)],
          [roundMm(pad.at[0] + hw), roundMm(pad.at[1] + hh)],
        );
      }
      continue;
    }

    if (GRAPHIC_TAGS.has(tag)) {
      const layer = extractLayer(child);
      const parsed = parseGraphic(child, tag);
      if (isSilkLayer(layer)) {
        if (parsed.silk) silk.push(parsed.silk);
        fallbackPoints.push(...parsed.bboxPoints);
      } else if (isCourtyardLayer(layer)) {
        crtPoints.push(...parsed.bboxPoints);
      } else {
        warnings.push(`Ignored ${tag} on unsupported layer "${layer ?? 'unknown'}"`);
      }
      continue;
    }

    warnings.push(`Ignored unknown footprint item "${tag}"`);
  }

  let courtyard: [number, number] = [0, 0];
  let courtyardBounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;

  const boxPoints = crtPoints.length > 0 ? crtPoints : fallbackPoints;
  if (boxPoints.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of boxPoints) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    minX = roundMm(minX);
    minY = roundMm(minY);
    maxX = roundMm(maxX);
    maxY = roundMm(maxY);
    courtyard = [roundMm(maxX - minX), roundMm(maxY - minY)];
    if (Math.abs(minX + maxX) > 1e-4 || Math.abs(minY + maxY) > 1e-4) {
      courtyardBounds = { minX, minY, maxX, maxY };
    }
  }

  if (Array.isArray(opts)) {
    opts.push(...warnings);
  } else if (opts?.warnings) {
    opts.warnings.push(...warnings);
  }

  return {
    name,
    pads,
    silk,
    courtyard,
    origin: [0, 0],
    ...(courtyardBounds ? { courtyardBounds } : {}),
    warnings,
  };
}

/** Serialize a CadLLM Footprint into a KiCad `.kicad_mod` S-expression string. */
export function exportKicadMod(fp: Footprint): string {
  const items: Sexpr[] = [
    sym('footprint'),
    str(fp.name),
    [sym('version'), num(20241229)],
    [sym('generator'), str('cadllm')],
    [sym('layer'), str('F.Cu')],
  ];

  for (const s of fp.silk) {
    const w = roundMm(s.width ?? 0.12);
    if (s.kind === 'line') {
      items.push([
        sym('fp_line'),
        [sym('start'), num(roundMm(s.from[0])), num(roundMm(s.from[1]))],
        [sym('end'), num(roundMm(s.to[0])), num(roundMm(s.to[1]))],
        [sym('layer'), str('F.SilkS')],
        [sym('width'), num(w)],
      ]);
    } else if (s.kind === 'rect') {
      items.push([
        sym('fp_rect'),
        [sym('start'), num(roundMm(s.at[0])), num(roundMm(s.at[1]))],
        [sym('end'), num(roundMm(s.at[0] + s.size[0])), num(roundMm(s.at[1] + s.size[1]))],
        [sym('layer'), str('F.SilkS')],
        [sym('width'), num(w)],
      ]);
    } else if (s.kind === 'circle') {
      items.push([
        sym('fp_circle'),
        [sym('center'), num(roundMm(s.at[0])), num(roundMm(s.at[1]))],
        [sym('end'), num(roundMm(s.at[0] + s.r)), num(roundMm(s.at[1]))],
        [sym('layer'), str('F.SilkS')],
        [sym('width'), num(w)],
      ]);
    } else if (s.kind === 'arc') {
      const toRad = (deg: number): number => (deg * Math.PI) / 180;
      const midDeg = (s.startDeg + s.endDeg) / 2;
      const sx = roundMm(s.at[0] + s.r * Math.cos(toRad(s.startDeg)));
      const sy = roundMm(s.at[1] + s.r * Math.sin(toRad(s.startDeg)));
      const mx = roundMm(s.at[0] + s.r * Math.cos(toRad(midDeg)));
      const my = roundMm(s.at[1] + s.r * Math.sin(toRad(midDeg)));
      const ex = roundMm(s.at[0] + s.r * Math.cos(toRad(s.endDeg)));
      const ey = roundMm(s.at[1] + s.r * Math.sin(toRad(s.endDeg)));
      items.push([
        sym('fp_arc'),
        [sym('start'), num(sx), num(sy)],
        [sym('mid'), num(mx), num(my)],
        [sym('end'), num(ex), num(ey)],
        [sym('layer'), str('F.SilkS')],
        [sym('width'), num(w)],
      ]);
    } else if (s.kind === 'poly') {
      items.push([
        sym('fp_poly'),
        [sym('pts'), ...s.points.map(([px, py]) => [sym('xy'), num(roundMm(px)), num(roundMm(py))])],
        [sym('layer'), str('F.SilkS')],
        [sym('width'), num(w)],
      ]);
    }
  }

  if (fp.courtyard[0] > 0 || fp.courtyard[1] > 0) {
    const b = fp.courtyardBounds ?? {
      minX: roundMm(-fp.courtyard[0] / 2),
      minY: roundMm(-fp.courtyard[1] / 2),
      maxX: roundMm(fp.courtyard[0] / 2),
      maxY: roundMm(fp.courtyard[1] / 2),
    };
    items.push([
      sym('fp_rect'),
      [sym('start'), num(roundMm(b.minX)), num(roundMm(b.minY))],
      [sym('end'), num(roundMm(b.maxX)), num(roundMm(b.maxY))],
      [sym('layer'), str('F.CrtYd')],
      [sym('width'), num(0.05)],
    ]);
  }

  for (const pad of fp.pads) {
    const padType = pad.layers === 'TH' ? 'thru_hole' : 'smd';
    const layerStrings =
      pad.layers === 'TH'
        ? ['*.Cu', '*.Mask']
        : pad.layers === 'B'
          ? ['B.Cu', 'B.Paste', 'B.Mask']
          : ['F.Cu', 'F.Paste', 'F.Mask'];
    const padExpr: Sexpr[] = [
      sym('pad'),
      str(pad.id),
      sym(padType),
      sym(pad.shape),
      [sym('at'), num(roundMm(pad.at[0])), num(roundMm(pad.at[1]))],
      [sym('size'), num(roundMm(pad.size[0])), num(roundMm(pad.size[1]))],
    ];
    if (pad.drill !== undefined) {
      padExpr.push([sym('drill'), num(roundMm(pad.drill))]);
    }
    padExpr.push([sym('layers'), ...layerStrings.map(str)]);
    if (pad.shape === 'roundrect') {
      padExpr.push([sym('roundrect_rratio'), num(roundMm(pad.roundRadius ?? 0.25))]);
    }
    items.push(padExpr);
  }

  return printSexpr(items, { pretty: true });
}
