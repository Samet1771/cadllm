// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { DEFAULT_PCB_RULES, type PcbLayer, type PcbRules } from '@cadllm/core';
import type { PadInstance, Point } from '@cadllm/pcb';
import { fmtMm, padLabel, PCB_SNAP_MM, snapMm } from './pcb.ts';

export interface PcbRouteSegmentGroup {
  layer: PcbLayer;
  points: Point[];
}

export interface PcbRouteState {
  netId: string;
  netName: string;
  startPad: PadInstance;
  activeLayer: PcbLayer;
  width: number;
  viaSize: number;
  viaDrill: number;
  rules: PcbRules;
  segments: PcbRouteSegmentGroup[];
  vias: Point[];
  cursorMm?: Point;
  hoverPad?: PadInstance;
}

const EPS = 1e-6;

function samePt(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
}

function roundPt(p: Point): Point {
  const rx = Math.round(p[0] * 1e4) / 1e4;
  const ry = Math.round(p[1] * 1e4) / 1e4;
  return [Object.is(rx, -0) ? 0 : rx, Object.is(ry, -0) ? 0 : ry];
}

/**
 * Snap `target` relative to `anchor` onto the nearest 45° or 90° ray,
 * snapping projection length to `gridStepMm` (default 0.5 mm).
 */
export function snapAngle45(anchor: Point, target: Point, gridStepMm = PCB_SNAP_MM): Point {
  const dx = target[0] - anchor[0];
  const dy = target[1] - anchor[1];
  if (Math.hypot(dx, dy) <= EPS) return roundPt(anchor);

  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const normSector = ((sector % 8) + 8) % 8;

  // Cardinal directions: 0 (E), 2 (S), 4 (W), 6 (N)
  if (normSector === 0 || normSector === 4) {
    return roundPt([snapMm(target[0], gridStepMm), anchor[1]]);
  }
  if (normSector === 2 || normSector === 6) {
    return roundPt([anchor[0], snapMm(target[1], gridStepMm)]);
  }

  // Diagonal 45° directions: 1 (SE), 3 (SW), 5 (NW), 7 (NE)
  const sx = normSector === 1 || normSector === 7 ? 1 : -1;
  const sy = normSector === 1 || normSector === 3 ? 1 : -1;
  // Project (dx, dy) onto unit diagonal (sx/sqrt2, sy/sqrt2) -> axis delta = (sx*dx + sy*dy)/2
  const rawDelta = Math.max(0, (sx * dx + sy * dy) / 2);
  const d = snapMm(rawDelta, gridStepMm);
  return roundPt([anchor[0] + sx * d, anchor[1] + sy * d]);
}

/**
 * Connect `a` to `b` using at most 2 octilinear (45°/90°) segments:
 * straight along the longer axis first, then 45° diagonal into `b`.
 */
export function route45Elbow(a: Point, b: Point): Point[] {
  const pa = roundPt(a);
  const pb = roundPt(b);
  if (samePt(pa, pb)) return [pa];
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  if (Math.abs(dx) <= EPS || Math.abs(dy) <= EPS || Math.abs(Math.abs(dx) - Math.abs(dy)) <= EPS) {
    return [pa, pb];
  }
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const diag = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const bend: Point = adx > ady
    ? roundPt([pb[0] - sx * diag, pa[1]])
    : roundPt([pa[0], pb[1] - sy * diag]);
  if (samePt(pa, bend) || samePt(bend, pb)) return [pa, pb];
  return [pa, bend, pb];
}

/** Remove duplicate consecutive points and collinear intermediate points. */
export function collapseCollinear(points: readonly Point[]): Point[] {
  const deduped: Point[] = [];
  for (const raw of points) {
    const p = roundPt(raw);
    const last = deduped[deduped.length - 1];
    if (!last || !samePt(last, p)) deduped.push(p);
  }
  if (deduped.length <= 2) return deduped;

  const out: Point[] = [deduped[0]!];
  for (let i = 1; i + 1 < deduped.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = deduped[i]!;
    const next = deduped[i + 1]!;
    const v1x = cur[0] - prev[0];
    const v1y = cur[1] - prev[1];
    const v2x = next[0] - cur[0];
    const v2y = next[1] - cur[1];
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    if (Math.abs(cross) <= 1e-6 && dot >= 0) continue;
    out.push(cur);
  }
  out.push(deduped[deduped.length - 1]!);
  return out;
}

function appendPoints(existing: readonly Point[], extra: readonly Point[]): Point[] {
  return collapseCollinear([...existing, ...extra]);
}

function activeSegment(state: PcbRouteState): PcbRouteSegmentGroup {
  return state.segments[state.segments.length - 1]!;
}

export function routeLastPoint(state: PcbRouteState): Point {
  const seg = activeSegment(state);
  return seg.points[seg.points.length - 1]!;
}

export function isSameNetPad(state: PcbRouteState, pad: PadInstance): boolean {
  if (!pad.netId || pad.netId !== state.netId) return false;
  return !(pad.compId === state.startPad.compId && pad.pinId === state.startPad.pinId);
}

export function isPadReachableOnLayer(pad: PadInstance, layer: PcbLayer): boolean {
  return pad.layers === 'TH' || pad.layers === layer;
}

/** Start interactive routing from a pad. Returns an error object if the pad has no net. */
export function startPcbRoute(
  pad: PadInstance,
  activeLayer: PcbLayer,
  rules: PcbRules = DEFAULT_PCB_RULES,
): { ok: true; state: PcbRouteState } | { ok: false; error: string } {
  if (!pad.netId || !pad.net) {
    return { ok: false, error: `Pad ${padLabel(pad)} has no net — connect pins first` };
  }
  const startLayer: PcbLayer = pad.layers === 'TH' ? activeLayer : pad.layers;
  const startPt = roundPt(pad.at);
  return {
    ok: true,
    state: {
      netId: pad.netId,
      netName: pad.net,
      startPad: pad,
      activeLayer: startLayer,
      width: rules.track,
      viaSize: rules.via,
      viaDrill: rules.drill,
      rules,
      segments: [{ layer: startLayer, points: [startPt] }],
      vias: [],
      cursorMm: startPt,
    },
  };
}

/** Update live cursor position and hovered target pad during routing. */
export function updateRouteCursor(
  state: PcbRouteState,
  cursorMm: Point,
  hoverPad?: PadInstance,
): PcbRouteState {
  return {
    ...state,
    cursorMm,
    ...(hoverPad ? { hoverPad } : { hoverPad: undefined }),
  };
}

/** Add a 45°/90°-snapped bend point to the active routing session. */
export function addRouteBend(
  state: PcbRouteState,
  targetMm: Point,
  gridStepMm = PCB_SNAP_MM,
): PcbRouteState {
  const anchor = routeLastPoint(state);
  const snapped = snapAngle45(anchor, targetMm, gridStepMm);
  if (samePt(anchor, snapped)) return state;
  const nextSegments = state.segments.map((seg, idx) =>
    idx === state.segments.length - 1
      ? { ...seg, points: appendPoints(seg.points, [snapped]) }
      : seg,
  );
  return {
    ...state,
    segments: nextSegments,
    cursorMm: snapped,
  };
}

/** Insert a via at the current snapped point (or explicit `atMm`) and switch F <-> B layer. */
export function insertRouteVia(
  state: PcbRouteState,
  atMm?: Point,
  gridStepMm = PCB_SNAP_MM,
): PcbRouteState {
  const anchor = routeLastPoint(state);
  const viaPt = atMm
    ? roundPt(atMm)
    : state.cursorMm
      ? snapAngle45(anchor, state.cursorMm, gridStepMm)
      : anchor;

  const updatedSegments = state.segments.map((seg, idx) =>
    idx === state.segments.length - 1 && !samePt(anchor, viaPt)
      ? { ...seg, points: appendPoints(seg.points, [viaPt]) }
      : seg,
  );

  const nextLayer: PcbLayer = state.activeLayer === 'F' ? 'B' : 'F';
  const hasViaAtPt = state.vias.some(v => samePt(v, viaPt));
  const nextVias = hasViaAtPt ? state.vias : [...state.vias, viaPt];

  return {
    ...state,
    activeLayer: nextLayer,
    vias: nextVias,
    segments: [...updatedSegments, { layer: nextLayer, points: [viaPt] }],
    cursorMm: viaPt,
  };
}

/** Build a single CNL `track` edit line. */
export function buildTrackEditLine(
  netName: string,
  layer: PcbLayer,
  width: number,
  points: readonly Point[],
): string {
  const pts = points.map(([x, y]) => `${fmtMm(x)},${fmtMm(y)}`).join(' ');
  return `track ${netName} ${layer} ${fmtMm(width)} ${pts}`;
}

/** Build a single CNL `via` edit line (omitting size/drill when matching rules). */
export function buildViaEditLine(
  netName: string,
  at: Point,
  opts?: { size?: number; drill?: number; rules?: PcbRules },
): string {
  const rules = opts?.rules ?? DEFAULT_PCB_RULES;
  const custom =
    (opts?.size !== undefined && Math.abs(opts.size - rules.via) > 1e-6)
    || (opts?.drill !== undefined && Math.abs(opts.drill - rules.drill) > 1e-6);
  const tail = custom
    ? ` size=${fmtMm(opts?.size ?? rules.via)} drill=${fmtMm(opts?.drill ?? rules.drill)}`
    : '';
  return `via ${netName} ${fmtMm(at[0])},${fmtMm(at[1])}${tail}`;
}

/** Build a CNL `-tracks NET` edit line. */
export function buildRemoveTracksCnl(netName: string): string {
  return `-tracks ${netName}`;
}

/** Build a CNL `REF @pcb:...` edit line. */
export function buildPcbPlaceEdit(ref: string, pcbPlace: string): string {
  return `${ref} @pcb:${pcbPlace}`;
}

export type FinishRouteResult =
  | {
    ok: true;
    editCnl: string;
    trackCount: number;
    viaCount: number;
    segments: PcbRouteSegmentGroup[];
    vias: Point[];
  }
  | {
    ok: false;
    error: string;
  };

/** Finish routing onto `targetPad` and emit CNL `track` / `via` edit lines. */
export function finishPcbRoute(
  state: PcbRouteState,
  targetPad: PadInstance,
): FinishRouteResult {
  if (targetPad.compId === state.startPad.compId && targetPad.pinId === state.startPad.pinId) {
    return { ok: false, error: 'Click a different pad on the same net to finish routing' };
  }
  if (!targetPad.netId || targetPad.netId !== state.netId) {
    return {
      ok: false,
      error: `Target pad ${padLabel(targetPad)} is not on net ${state.netName}`,
    };
  }
  if (!isPadReachableOnLayer(targetPad, state.activeLayer)) {
    return {
      ok: false,
      error: `Pad ${padLabel(targetPad)} is on layer ${targetPad.layers}; press V to place a via`,
    };
  }

  const last = routeLastPoint(state);
  const tail = route45Elbow(last, targetPad.at);
  const finalSegments = state.segments
    .map((seg, idx) =>
      idx === state.segments.length - 1
        ? { ...seg, points: appendPoints(seg.points, tail) }
        : { ...seg, points: collapseCollinear(seg.points) },
    )
    .filter(seg => seg.points.length >= 2);

  if (finalSegments.length === 0) {
    return { ok: false, error: 'Route has zero length' };
  }

  const lines: string[] = [];
  for (const seg of finalSegments) {
    lines.push(buildTrackEditLine(state.netName, seg.layer, state.width, seg.points));
  }
  for (const v of state.vias) {
    lines.push(buildViaEditLine(state.netName, v, { size: state.viaSize, drill: state.viaDrill, rules: state.rules }));
  }

  return {
    ok: true,
    editCnl: lines.join('\n'),
    trackCount: finalSegments.length,
    viaCount: state.vias.length,
    segments: finalSegments,
    vias: state.vias,
  };
}

/** Compute live preview polyline segments (committed + rubber-band) in mm for SVG overlay rendering. */
export function previewRoutePaths(
  state: PcbRouteState,
  gridStepMm = PCB_SNAP_MM,
): { committed: PcbRouteSegmentGroup[]; activePreview: Point[]; snappedToPad: boolean } {
  const anchor = routeLastPoint(state);
  let activePreview: Point[] = [];
  let snappedToPad = false;

  if (
    state.hoverPad
    && isSameNetPad(state, state.hoverPad)
    && isPadReachableOnLayer(state.hoverPad, state.activeLayer)
  ) {
    activePreview = route45Elbow(anchor, state.hoverPad.at);
    snappedToPad = true;
  } else if (state.cursorMm) {
    const snapped = snapAngle45(anchor, state.cursorMm, gridStepMm);
    if (!samePt(anchor, snapped)) {
      activePreview = [anchor, snapped];
    }
  }

  return {
    committed: state.segments,
    activePreview,
    snappedToPad,
  };
}
