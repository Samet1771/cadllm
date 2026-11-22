// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import {
  DEFAULT_PCB_RULES,
  type PcbLayer,
  type PcbRules,
  type PcbTrack,
  type PcbVia,
  type Query,
} from '@cadllm/core';
import {
  formatPcbPlace,
  parsePcbPlace,
  type PadInstance,
  type PcbPlace,
  type PcbRenderLayer,
  type Point,
} from '@cadllm/pcb';

export const PCB_SNAP_MM = 0.5;

export interface PcbLayerVisibility {
  F: boolean;
  B: boolean;
  silk: boolean;
  outline: boolean;
  ratsnest: boolean;
  courtyard: boolean;
}

export const DEFAULT_PCB_LAYERS: PcbLayerVisibility = {
  F: true,
  B: true,
  silk: true,
  outline: true,
  ratsnest: true,
  courtyard: false,
};

export const PCB_LAYER_ORDER: readonly PcbRenderLayer[] = [
  'F',
  'B',
  'silk',
  'outline',
  'ratsnest',
  'courtyard',
];

export function visibleLayersToArray(vis: PcbLayerVisibility): PcbRenderLayer[] {
  return PCB_LAYER_ORDER.filter(layer => vis[layer]);
}

const zeroSafe = (n: number): number => (Object.is(n, -0) ? 0 : n);

/** Format a millimetre coordinate deterministically (up to 4 decimals, no trailing zeros, no -0). */
export function fmtMm(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Snap a millimetre scalar to the nearest grid step (default 0.5 mm). */
export function snapMm(mm: number, step = PCB_SNAP_MM): number {
  if (step <= 0) return zeroSafe(mm);
  const snapped = Math.round(mm / step) * step;
  return zeroSafe(Math.round(snapped * 1e4) / 1e4);
}

/** Snap a 2D point in millimetres to the nearest grid step (default 0.5 mm). */
export function snapPointMm(pt: Point, step = PCB_SNAP_MM): Point {
  return [snapMm(pt[0], step), snapMm(pt[1], step)];
}

/** Normalize clockwise degrees to [0, 360). */
export function normalizePcbRot(deg: number): number {
  const n = ((Math.round(deg * 1e4) / 1e4) % 360 + 360) % 360;
  return zeroSafe(n);
}

/** Shift an existing PCB placement by mm delta (snapped to 0.5 mm), or place at `fallbackMm`. */
export function movePcbPlace(
  raw: string | undefined,
  dxMm: number,
  dyMm: number,
  fallbackMm: Point,
  step = PCB_SNAP_MM,
): string {
  const cur = parsePcbPlace(raw);
  if (cur) {
    return formatPcbPlace({
      ...cur,
      x: snapMm(cur.x + dxMm, step),
      y: snapMm(cur.y + dyMm, step),
    });
  }
  const [fx, fy] = snapPointMm(fallbackMm, step);
  return formatPcbPlace({ x: fx, y: fy, rot: 0, side: 'top' });
}

/** Rotate a PCB placement clockwise by `stepDeg` (default 90°). */
export function rotatePcbPlace(
  raw: string | undefined,
  stepDeg = 90,
  fallbackMm: Point = [0, 0],
): string {
  const cur: PcbPlace = parsePcbPlace(raw) ?? {
    x: snapMm(fallbackMm[0]),
    y: snapMm(fallbackMm[1]),
    rot: 0,
    side: 'top',
  };
  return formatPcbPlace({
    ...cur,
    rot: normalizePcbRot(cur.rot + stepDeg),
  });
}

/** Flip a PCB placement between 'top' and 'bottom' sides. */
export function flipPcbPlace(
  raw: string | undefined,
  fallbackMm: Point = [0, 0],
): string {
  const cur: PcbPlace = parsePcbPlace(raw) ?? {
    x: snapMm(fallbackMm[0]),
    y: snapMm(fallbackMm[1]),
    rot: 0,
    side: 'top',
  };
  return formatPcbPlace({
    ...cur,
    side: cur.side === 'top' ? 'bottom' : 'top',
  });
}

/** Effective PCB design rules (merging defaults with circuit.pcb.rules). */
export function getPcbRules(query: Query): PcbRules {
  return { ...DEFAULT_PCB_RULES, ...query.circuit.pcb?.rules };
}

export function trackWidthFromRules(query: Query): number {
  return getPcbRules(query).track;
}

export function viaSpecFromRules(query: Query): { size: number; drill: number } {
  const r = getPcbRules(query);
  return { size: r.via, drill: r.drill };
}

/** Resolve net display name from a net id in Query. */
export function netNameById(query: Query, netId: string): string {
  return query.circuit.nets[netId]?.name ?? netId;
}

/** Euclidean distance from point `p` to line segment `a`–`b`. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function isPadOnLayer(pad: PadInstance, layer: PcbLayer): boolean {
  return pad.layers === 'TH' || pad.layers === layer;
}

function padContainsPoint(pad: PadInstance, worldMm: Point, toleranceMm: number): number | undefined {
  const dx = worldMm[0] - pad.at[0];
  const dy = worldMm[1] - pad.at[1];
  const rad = (-pad.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  const hw = pad.size[0] / 2 + toleranceMm;
  const hh = pad.size[1] / 2 + toleranceMm;

  if (pad.shape === 'circle') {
    const r = Math.max(pad.size[0], pad.size[1]) / 2 + toleranceMm;
    const d = Math.hypot(lx, ly);
    return d <= r ? d : undefined;
  }

  if (pad.shape === 'oval') {
    // Capsule distance along the longer axis
    if (pad.size[0] >= pad.size[1]) {
      const r = pad.size[1] / 2 + toleranceMm;
      const halfSpan = Math.max(0, pad.size[0] / 2 - pad.size[1] / 2);
      const clampedX = Math.max(-halfSpan, Math.min(halfSpan, lx));
      const d = Math.hypot(lx - clampedX, ly);
      return d <= r ? Math.hypot(dx, dy) : undefined;
    }
    const r = pad.size[0] / 2 + toleranceMm;
    const halfSpan = Math.max(0, pad.size[1] / 2 - pad.size[0] / 2);
    const clampedY = Math.max(-halfSpan, Math.min(halfSpan, ly));
    const d = Math.hypot(lx, ly - clampedY);
    return d <= r ? Math.hypot(dx, dy) : undefined;
  }

  // 'rect' | 'roundrect'
  if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) {
    return Math.hypot(dx, dy);
  }
  return undefined;
}

export interface PadHitOptions {
  /** If provided, restrict to pads present on this copper layer (or 'TH'). */
  layer?: PcbLayer;
  /** If provided, only check pads on visible copper layers ('F' / 'B'). */
  visibleLayers?: Set<PcbLayer>;
  toleranceMm?: number;
}

/**
 * Hit-test pads from `pads(q)` at a world coordinate in mm.
 * Returns the closest matching PadInstance, or undefined.
 */
export function hitTestPads(
  padList: readonly PadInstance[],
  worldMm: Point,
  opts: PadHitOptions = {},
): PadInstance | undefined {
  const tol = opts.toleranceMm ?? 0.25;
  let best: PadInstance | undefined;
  let bestDist = Infinity;

  for (const pad of padList) {
    if (opts.layer && !isPadOnLayer(pad, opts.layer)) continue;
    if (opts.visibleLayers) {
      const visible =
        pad.layers === 'TH'
          ? opts.visibleLayers.has('F') || opts.visibleLayers.has('B')
          : opts.visibleLayers.has(pad.layers);
      if (!visible) continue;
    }
    const d = padContainsPoint(pad, worldMm, tol);
    if (d !== undefined && d < bestDist) {
      bestDist = d;
      best = pad;
    }
  }
  return best;
}

export interface TrackHit {
  index: number;
  track: PcbTrack;
  netName: string;
  distance: number;
}

/**
 * Hit-test PCB tracks at a world coordinate in mm.
 * Returns the closest track within `track.width / 2 + toleranceMm`.
 */
export function hitTestTrack(
  tracks: readonly PcbTrack[],
  query: Query,
  worldMm: Point,
  visibleLayers: ReadonlySet<PcbLayer> = new Set<PcbLayer>(['F', 'B']),
  toleranceMm = 0.35,
): TrackHit | undefined {
  let best: TrackHit | undefined;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    if (!visibleLayers.has(track.layer)) continue;
    if (track.points.length < 2) continue;
    let minD = Infinity;
    for (let j = 0; j + 1 < track.points.length; j++) {
      const d = distToSegment(worldMm, track.points[j]!, track.points[j + 1]!);
      if (d < minD) minD = d;
    }
    const threshold = track.width / 2 + toleranceMm;
    if (minD <= threshold && (!best || minD < best.distance)) {
      best = {
        index: i,
        track,
        netName: netNameById(query, track.net),
        distance: minD,
      };
    }
  }
  return best;
}

export interface ViaHit {
  index: number;
  via: PcbVia;
  netName: string;
  distance: number;
}

/** Hit-test PCB vias at a world coordinate in mm. */
export function hitTestVia(
  vias: readonly PcbVia[],
  query: Query,
  worldMm: Point,
  toleranceMm = 0.25,
): ViaHit | undefined {
  let best: ViaHit | undefined;
  for (let i = 0; i < vias.length; i++) {
    const via = vias[i]!;
    const d = Math.hypot(worldMm[0] - via.at[0], worldMm[1] - via.at[1]);
    if (d <= via.size / 2 + toleranceMm && (!best || d < best.distance)) {
      best = {
        index: i,
        via,
        netName: netNameById(query, via.net),
        distance: d,
      };
    }
  }
  return best;
}

/** Canonical pin label for a PadInstance (`R1.2`, `D1.A`). */
export function padLabel(pad: PadInstance): string {
  const lbl = pad.pinLabel || pad.pinId;
  return lbl.toUpperCase().startsWith(`${pad.ref.toUpperCase()}.`) ? lbl : `${pad.ref}.${lbl}`;
}

/** Compute a bounding box in world mm for a DRC issue's `at` entries (for click-to-zoom). */
export function boundsForDrcTargets(
  query: Query,
  padList: readonly PadInstance[],
  at: readonly string[],
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePt = (x: number, y: number, pad = 2) => {
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  };

  for (const raw of at) {
    const token = raw.trim();
    if (!token) continue;
    const refPart = token.includes('.') ? token.slice(0, token.indexOf('.')) : token;
    const pinPart = token.includes('.') ? token.slice(token.indexOf('.') + 1) : undefined;

    if (pinPart) {
      const matchingPads = padList.filter(
        p =>
          p.ref.toUpperCase() === refPart.toUpperCase()
          && (
            p.pinId.toUpperCase() === pinPart.toUpperCase()
            || p.pinLabel.toUpperCase() === pinPart.toUpperCase()
            || padLabel(p).toUpperCase() === token.toUpperCase()
          ),
      );
      if (matchingPads.length > 0) {
        for (const p of matchingPads) includePt(p.at[0], p.at[1], Math.max(p.size[0], p.size[1]) / 2 + 1.5);
        continue;
      }
    }

    const comp = query.component(refPart);
    if (comp) {
      const compPads = padList.filter(p => p.compId === comp.id);
      if (compPads.length > 0) {
        for (const p of compPads) includePt(p.at[0], p.at[1], 2.5);
      } else {
        const parsed = parsePcbPlace(comp.place.pcb);
        if (parsed) includePt(parsed.x, parsed.y, 4);
      }
      continue;
    }

    const netName = token.toLowerCase().startsWith('net:') ? token.slice(4) : token;
    const net = query.net(netName);
    if (net) {
      for (const p of padList) {
        if (p.netId === net.id) includePt(p.at[0], p.at[1], 2.5);
      }
      for (const t of query.circuit.pcb?.tracks ?? []) {
        if (t.net === net.id) {
          for (const pt of t.points) includePt(pt[0], pt[1], 2);
        }
      }
      for (const v of query.circuit.pcb?.vias ?? []) {
        if (v.net === net.id) includePt(v.at[0], v.at[1], 2);
      }
    }
  }

  if (!Number.isFinite(minX)) return undefined;
  return { minX, minY, maxX, maxY };
}
