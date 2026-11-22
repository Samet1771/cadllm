// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { DEFAULT_PCB_RULES, naturalCompare, type Net, type PcbLayer, type PcbRules, type PcbTrack, type PcbVia, type Query } from '@cadllm/core';
import { analyzeConnectivity, type Anchor, type CopperItem, type NetIsland } from '../connect/index.ts';
import {
  padLayersOf,
  pointToShapeDist,
  segToShapeDist,
  segmentToShape,
  shapeInsideBoardDist,
  viaToShape,
  type CopperShape,
} from '../connect/geom.ts';
import { pointInPolygon, polyBounds, roundMm } from '../place/geometry.ts';
import type { PadInstance, Point, RouteOptions, RouteResult } from '../types.ts';

const EPS = 1e-5;
const TRACK_F = 1;
const TRACK_B = 2;
const VIA_OK = 4;
const EMPTY_DYN_ROUTES = new Map<number, DynamicRoute>();

// 8 directions: E, SE, S, SW, W, NW, N, NE
const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const STEP_LEN = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2] as const;

interface Obstacle {
  netKey: string;
  shape: CopperShape;
}

interface PadStamp {
  pad: PadInstance;
  netKey: string;
  shape: CopperShape;
  layers: readonly PcbLayer[];
  blockTrackCells: number[];
  blockViaCells: number[];
}

interface DynamicRoute {
  netId: string;
  tracks: PcbTrack[];
  vias: PcbVia[];
  shapes: Obstacle[];
  cellsF: number[];
  cellsB: number[];
  cellsVia: number[];
}

interface TargetNet {
  net: Net;
  slot: number; // 1-based index in dynamic nets
  islands: NetIsland[];
  mstLen: number;
}

class MinHeap {
  private keys: number[] = [];
  private scores: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  clear(): void {
    this.keys.length = 0;
    this.scores.length = 0;
  }

  push(key: number, score: number): void {
    const keys = this.keys;
    const scores = this.scores;
    let i = keys.length;
    keys.push(key);
    scores.push(score);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (scores[p]! <= score) break;
      keys[i] = keys[p]!;
      scores[i] = scores[p]!;
      i = p;
    }
    keys[i] = key;
    scores[i] = score;
  }

  pop(): { key: number; score: number } {
    const keys = this.keys;
    const scores = this.scores;
    const topKey = keys[0]!;
    const topScore = scores[0]!;
    const lastKey = keys.pop()!;
    const lastScore = scores.pop()!;
    if (keys.length > 0) {
      let i = 0;
      const n = keys.length;
      while (true) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const best = r < n && scores[r]! < scores[l]! ? r : l;
        if (lastScore <= scores[best]!) break;
        keys[i] = keys[best]!;
        scores[i] = scores[best]!;
        i = best;
      }
      keys[i] = lastKey;
      scores[i] = lastScore;
    }
    return { key: topKey, score: topScore };
  }
}

interface GridCtx {
  grid: number;
  ox: number;
  oy: number;
  cols: number;
  rows: number;
  size: number;
  rules: PcbRules;
  board?: Point[];
  segMargin: number;
  boardMask: Uint8Array;
  baseF: Uint8Array;
  baseB: Uint8Array;
  baseVia: Uint8Array;
  padStamps: PadStamp[];
  fixedObstacles: Obstacle[];
  history: Float32Array;
}

function defaultGridSize(rules: PcbRules): number {
  return Math.max(0.1, Math.min(0.25, Math.round(Math.min(rules.clearance + 0.05, rules.track) * 20) / 20));
}

function cellRange(minV: number, maxV: number, origin: number, grid: number, maxIdx: number): [number, number] {
  const lo = Math.max(0, Math.floor((minV - origin) / grid));
  const hi = Math.min(maxIdx, Math.ceil((maxV - origin) / grid));
  return [lo, hi];
}

function rasterizeShape(
  shape: CopperShape,
  radiusExpand: number,
  grid: number,
  ox: number,
  oy: number,
  cols: number,
  rows: number,
): number[] {
  const out: number[] = [];
  const [x0, x1] = cellRange(shape.minX - radiusExpand, shape.maxX + radiusExpand, ox, grid, cols - 1);
  const [y0, y1] = cellRange(shape.minY - radiusExpand, shape.maxY + radiusExpand, oy, grid, rows - 1);
  for (let gy = y0; gy <= y1; gy++) {
    const py = oy + gy * grid;
    const rowOff = gy * cols;
    for (let gx = x0; gx <= x1; gx++) {
      const px = ox + gx * grid;
      if (pointToShapeDist(px, py, shape) < radiusExpand) {
        out.push(rowOff + gx);
      }
    }
  }
  return out;
}

function segClearanceOk(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  layer: PcbLayer,
  width: number,
  netKey: string,
  ctx: GridCtx,
  dynRoutes: Map<number, DynamicRoute>,
): boolean {
  const halfW = width / 2;
  const minX = Math.min(ax, bx) - halfW - ctx.rules.clearance;
  const maxX = Math.max(ax, bx) + halfW + ctx.rules.clearance;
  const minY = Math.min(ay, by) - halfW - ctx.rules.clearance;
  const maxY = Math.max(ay, by) + halfW + ctx.rules.clearance;

  if (ctx.board && ctx.board.length >= 3) {
    const res = shapeInsideBoardDist(segmentToShape(ax, ay, bx, by, width, layer), ctx.board);
    if (!res.inside || res.edgeClearance < ctx.rules.clearance - EPS) return false;
  }

  const checkObs = (obs: Obstacle): boolean => {
    if (obs.netKey === netKey) return true;
    const s = obs.shape;
    if (!s.layers.includes(layer)) return true;
    if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY) return true;
    return segToShapeDist(ax, ay, bx, by, halfW, s) >= ctx.rules.clearance - EPS;
  };

  for (const ps of ctx.padStamps) {
    if (ps.netKey === netKey) continue;
    if (!ps.layers.includes(layer)) continue;
    const s = ps.shape;
    if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY) continue;
    if (segToShapeDist(ax, ay, bx, by, halfW, s) < ctx.rules.clearance - EPS) return false;
  }
  for (const obs of ctx.fixedObstacles) {
    if (!checkObs(obs)) return false;
  }
  for (const dr of dynRoutes.values()) {
    if (dr.netId === netKey) continue;
    for (const obs of dr.shapes) {
      if (!checkObs(obs)) return false;
    }
  }
  return true;
}

function buildGridCtx(
  q: Query,
  pads: PadInstance[],
  fixedItems: CopperItem[],
  rules: PcbRules,
  grid: number,
): GridCtx {
  const board = q.circuit.pcb?.board?.outline;
  const hasBoard = board !== undefined && board.length >= 3;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (hasBoard) {
    const b = polyBounds(board);
    minX = b.minX;
    minY = b.minY;
    maxX = b.maxX;
    maxY = b.maxY;
  } else {
    for (const p of pads) {
      minX = Math.min(minX, p.at[0] - p.size[0] / 2);
      maxX = Math.max(maxX, p.at[0] + p.size[0] / 2);
      minY = Math.min(minY, p.at[1] - p.size[1] / 2);
      maxY = Math.max(maxY, p.at[1] + p.size[1] / 2);
    }
    for (const item of fixedItems) {
      minX = Math.min(minX, item.shape.minX);
      maxX = Math.max(maxX, item.shape.maxX);
      minY = Math.min(minY, item.shape.minY);
      maxY = Math.max(maxY, item.shape.maxY);
    }
    if (!Number.isFinite(minX)) {
      minX = 0; minY = 0; maxX = 40; maxY = 30;
    } else {
      minX -= 5; minY -= 5; maxX += 5; maxY += 5;
    }
  }

  const ox = Math.floor(minX / grid) * grid;
  const oy = Math.floor(minY / grid) * grid;
  const cols = Math.max(2, Math.ceil((maxX - ox) / grid) + 1);
  const rows = Math.max(2, Math.ceil((maxY - oy) / grid) + 1);
  const size = cols * rows;

  const trackHalf = rules.track / 2;
  const viaHalf = rules.via / 2;
  const edgeR = trackHalf + rules.clearance;
  const sagitta = Math.max(0.005, edgeR - Math.sqrt(Math.max(0, edgeR * edgeR - (grid * 0.5) * (grid * 0.5))));
  const segMargin = Math.min(0.025, sagitta + 0.005);

  const boardMask = new Uint8Array(size);
  const baseF = new Uint8Array(size);
  const baseB = new Uint8Array(size);
  const baseVia = new Uint8Array(size);

  if (hasBoard) {
    const minTrackEdge = rules.clearance + trackHalf + segMargin - 1e-6;
    const minViaEdge = rules.clearance + viaHalf - 1e-6;
    for (let gy = 0; gy < rows; gy++) {
      const py = oy + gy * grid;
      const rowOff = gy * cols;
      for (let gx = 0; gx < cols; gx++) {
        const px = ox + gx * grid;
        const idx = rowOff + gx;
        if (!pointInPolygon([px, py], board, -1e-6)) {
          baseF[idx] = 1;
          baseB[idx] = 1;
          baseVia[idx] = 1;
          continue;
        }
        const res = shapeInsideBoardDist({ core: { kind: 'point', x: px, y: py }, r: 0, layers: ['F'], minX: px, minY: py, maxX: px, maxY: py }, board);
        let mask = 0;
        if (res.inside && res.edgeClearance >= minTrackEdge) mask |= TRACK_F | TRACK_B;
        else { baseF[idx] = 1; baseB[idx] = 1; }
        if (res.inside && res.edgeClearance >= minViaEdge) mask |= VIA_OK;
        else baseVia[idx] = 1;
        boardMask[idx] = mask;
      }
    }
  } else {
    boardMask.fill(TRACK_F | TRACK_B | VIA_OK);
  }

  const padStamps: PadStamp[] = [];
  const fixedObstacles: Obstacle[] = [];

  for (const item of fixedItems) {
    if (item.kind === 'pad') {
      const pad = item.pad!;
      const trackExp = trackHalf + rules.clearance + segMargin;
      const viaExp = viaHalf + rules.clearance + 1e-4;
      padStamps.push({
        pad,
        netKey: item.netKey,
        shape: item.shape,
        layers: item.shape.layers,
        blockTrackCells: rasterizeShape(item.shape, trackExp, grid, ox, oy, cols, rows),
        blockViaCells: rasterizeShape(item.shape, viaExp, grid, ox, oy, cols, rows),
      });
      continue;
    }

    // Fixed track or via from non-rerouted existing copper
    fixedObstacles.push({ netKey: item.netKey, shape: item.shape });
  }

  return {
    grid,
    ox,
    oy,
    cols,
    rows,
    size,
    rules,
    ...(hasBoard ? { board } : {}),
    segMargin,
    boardMask,
    baseF,
    baseB,
    baseVia,
    padStamps,
    fixedObstacles,
    history: new Float32Array(size * 2),
  };
}

interface IslandGridTargets {
  /** Maps `(layer * size + cellIdx)` -> anchor point to connect to/from. */
  cells: Map<number, { anchor: Point; dist: number; inside: boolean }>;
  anchors: Anchor[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function collectIslandGridNodes(
  island: NetIsland,
  netId: string,
  ctx: GridCtx,
  hardF: Uint8Array,
  hardB: Uint8Array,
  dynOwnerF: Int32Array,
  dynOwnerB: Int32Array,
  dynRoutes: Map<number, DynamicRoute>,
  allowSoft: boolean,
): IslandGridTargets {
  const cells = new Map<number, { anchor: Point; dist: number; inside: boolean }>();
  const { grid, ox, oy, cols, rows, size, rules } = ctx;
  const trackW = rules.track;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const record = (cellIdx: number, layerIdx: 0 | 1, anchor: Point, dist: number, inside: boolean) => {
    const hard = layerIdx === 0 ? hardF[cellIdx]! : hardB[cellIdx]!;
    if (hard) return;
    if (!allowSoft) {
      const dyn = layerIdx === 0 ? dynOwnerF[cellIdx]! : dynOwnerB[cellIdx]!;
      if (dyn !== 0) return;
    }
    const key = layerIdx * size + cellIdx;
    const prev = cells.get(key);
    if (!prev || (inside && !prev.inside) || (inside === prev.inside && dist < prev.dist)) {
      cells.set(key, { anchor, dist, inside });
    }
  };

  for (const item of island.items) {
    minX = Math.min(minX, item.shape.minX);
    minY = Math.min(minY, item.shape.minY);
    maxX = Math.max(maxX, item.shape.maxX);
    maxY = Math.max(maxY, item.shape.maxY);

    const anchor: Point = item.pad ? item.pad.at : item.anchors[0]!.at;
    const padExpand = item.kind === 'track' ? 1e-4 : grid * 1.1;
    const [x0, x1] = cellRange(item.shape.minX - padExpand, item.shape.maxX + padExpand, ox, grid, cols - 1);
    const [y0, y1] = cellRange(item.shape.minY - padExpand, item.shape.maxY + padExpand, oy, grid, rows - 1);

    for (const layer of item.shape.layers) {
      const layerIdx: 0 | 1 = layer === 'F' ? 0 : 1;
      for (let gy = y0; gy <= y1; gy++) {
        const py = oy + gy * grid;
        const rowOff = gy * cols;
        for (let gx = x0; gx <= x1; gx++) {
          const px = ox + gx * grid;
          const cIdx = rowOff + gx;
          const dShape = pointToShapeDist(px, py, item.shape);
          const inside = dShape <= 1e-5;
          if (!inside && item.kind === 'track') continue;
          if (!inside && dShape > grid * 1.15) continue;

          // Choose nearest endpoint on track/via/pad as anchor
          let bestAnchor = anchor;
          if (item.anchors.length > 1) {
            let bestD = Infinity;
            for (const a of item.anchors) {
              const da = Math.hypot(px - a.at[0], py - a.at[1]);
              if (da < bestD) { bestD = da; bestAnchor = a.at; }
            }
          }
          const dAnchor = Math.hypot(px - bestAnchor[0], py - bestAnchor[1]);
          const checkDyn = allowSoft ? EMPTY_DYN_ROUTES : dynRoutes;
          if (segClearanceOk(bestAnchor[0], bestAnchor[1], px, py, layer, trackW, netId, ctx, checkDyn)) {
            record(cIdx, layerIdx, bestAnchor, dAnchor, inside);
          }
        }
      }
    }
  }

  return {
    cells,
    anchors: island.anchors,
    bbox: { minX, minY, maxX, maxY },
  };
}

function isOctilinear(a: Point, b: Point): boolean {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  return dx <= 1e-4 || dy <= 1e-4 || Math.abs(dx - dy) <= 1e-4;
}

function simplifyTrackPoints(
  rawPts: Point[],
  layer: PcbLayer,
  width: number,
  netId: string,
  ctx: GridCtx,
  dynRoutes: Map<number, DynamicRoute>,
): Point[] {
  // 1. Deduplicate consecutive identical points
  const dedup: Point[] = [];
  for (const p of rawPts) {
    const rp: Point = [roundMm(p[0], 4), roundMm(p[1], 4)];
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(rp[0] - prev[0], rp[1] - prev[1]) > 1e-4) {
      dedup.push(rp);
    }
  }
  if (dedup.length <= 2) return dedup;

  // 2. Collinear merge
  const col: Point[] = [dedup[0]!];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = col[col.length - 1]!;
    const b = dedup[i]!;
    const c = dedup[i + 1]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const lenAc = Math.hypot(acx, acy);
    const cross = lenAc > 1e-9 ? Math.abs(abx * acy - aby * acx) / lenAc : 0;
    const dot = abx * (c[0] - b[0]) + aby * (c[1] - b[1]);
    if (cross <= 1e-4 && dot >= -1e-6) continue;
    col.push(b);
  }
  col.push(dedup[dedup.length - 1]!);
  if (col.length <= 2) return col;

  // 3. Greedy octilinear / endpoint shortcutting (verified with exact geometric clearance)
  const out: Point[] = [col[0]!];
  let i = 0;
  while (i < col.length - 1) {
    let jumped = false;
    const maxJ = Math.min(col.length - 1, i + 6);
    for (let j = maxJ; j > i + 1; j--) {
      const a = out[out.length - 1]!;
      const b = col[j]!;
      if (!isOctilinear(a, b) && i !== 0 && j !== col.length - 1) continue;
      if (segClearanceOk(a[0], a[1], b[0], b[1], layer, width, netId, ctx, dynRoutes)) {
        out.push(b);
        i = j;
        jumped = true;
        break;
      }
    }
    if (!jumped) {
      out.push(col[i + 1]!);
      i += 1;
    }
  }
  return out;
}

interface SearchScratch {
  gScore: Float64Array;
  parent: Int32Array;
  parentDir: Int8Array;
  closed: Uint8Array;
  heap: MinHeap;
}

function makeScratch(totalStates: number): SearchScratch {
  return {
    gScore: new Float64Array(totalStates),
    parent: new Int32Array(totalStates),
    parentDir: new Int8Array(totalStates),
    closed: new Uint8Array(totalStates),
    heap: new MinHeap(),
  };
}

function runAStar(
  netId: string,
  netSlot: number,
  startTargets: IslandGridTargets,
  endTargets: IslandGridTargets,
  ctx: GridCtx,
  hardF: Uint8Array,
  hardB: Uint8Array,
  hardVia: Uint8Array,
  dynOwnerF: Int32Array,
  dynOwnerB: Int32Array,
  dynOwnerVia: Int32Array,
  ownF: Uint8Array,
  ownB: Uint8Array,
  ownPad: Uint8Array,
  dynRoutes: Map<number, DynamicRoute>,
  scratch: SearchScratch,
  allowSoft: boolean,
): {
  tracks: PcbTrack[];
  vias: PcbVia[];
  goalKey: number;
  crossedSlots: Set<number>;
  contestedStates: number[];
} | undefined {
  if (startTargets.cells.size === 0 || endTargets.cells.size === 0) return undefined;

  const { grid, ox, oy, cols, rows, size, rules } = ctx;
  const totalStates = size * 2;
  const { gScore, parent, parentDir, closed, heap } = scratch;
  gScore.fill(Infinity);
  parent.fill(-1);
  parentDir.fill(-1);
  closed.fill(0);
  heap.clear();

  const endAnchors = endTargets.anchors.map(a => a.at);
  const bbox = endTargets.bbox;
  const heuristic = (gx: number, gy: number): number => {
    const px = ox + gx * grid;
    const py = oy + gy * grid;
    if (endAnchors.length <= 16) {
      let best = Infinity;
      for (const a of endAnchors) {
        const dx = Math.abs(px - a[0]);
        const dy = Math.abs(py - a[1]);
        const oct = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
        if (oct < best) best = oct;
      }
      return best * 1.001;
    }
    const dx = px < bbox.minX ? bbox.minX - px : px > bbox.maxX ? px - bbox.maxX : 0;
    const dy = py < bbox.minY ? bbox.minY - py : py > bbox.maxY ? py - bbox.maxY : 0;
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 1.001;
  };

  // Seed start nodes sorted deterministically
  const startKeys = [...startTargets.cells.keys()].sort((a, b) => a - b);
  for (const stateKey of startKeys) {
    const info = startTargets.cells.get(stateKey)!;
    const cellIdx = stateKey % size;
    const gy = Math.floor(cellIdx / cols);
    const gx = cellIdx - gy * cols;
    const g0 = info.inside ? 0 : info.dist * 0.5;
    if (g0 < gScore[stateKey]!) {
      gScore[stateKey] = g0;
      parent[stateKey] = -2; // sentinel for start
      parentDir[stateKey] = -1;
      heap.push(stateKey, g0 + heuristic(gx, gy));
    }
  }

  // Cost hierarchy: viaCost > bendCost > layerPref
  const viaCost = Math.max(2.5, grid * 12);
  const bend45Cost = Math.max(0.1, grid * 0.6);
  const bend90Cost = Math.max(0.2, grid * 1.2);
  const softPenalty = 25;
  const historyWeight = 15;
  const viaOnPadCost = 1.0;

  let goalKey = -1;
  let pops = 0;
  const maxPops = Math.min(totalStates, 350_000);

  while (heap.size > 0 && pops < maxPops) {
    const { key: curKey, score: curF } = heap.pop();
    if (closed[curKey]!) continue;
    closed[curKey] = 1;
    pops += 1;

    if (endTargets.cells.has(curKey)) {
      goalKey = curKey;
      break;
    }

    const curG = gScore[curKey]!;

    const curLayer: 0 | 1 = curKey >= size ? 1 : 0;
    const cellIdx = curLayer === 1 ? curKey - size : curKey;
    const gy = Math.floor(cellIdx / cols);
    const gx = cellIdx - gy * cols;
    const prevDir = parentDir[curKey]!;

    // 8 planar neighbors on same layer
    for (let d = 0; d < 8; d++) {
      const nx = gx + DX[d]!;
      const ny = gy + DY[d]!;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const nCell = ny * cols + nx;
      const nKey = curLayer * size + nCell;
      if (closed[nKey]!) continue;

      const isHard = curLayer === 0 ? hardF[nCell]! : hardB[nCell]!;
      if (isHard) continue;
      const dynOwner = curLayer === 0 ? dynOwnerF[nCell]! : dynOwnerB[nCell]!;
      if (!allowSoft && dynOwner !== 0) continue;

      // Diagonal corner safety: prevent diagonal crossing through blocked corner cells
      if ((d & 1) === 1) {
        const c1 = gy * cols + nx;
        const c2 = ny * cols + gx;
        const h1 = curLayer === 0 ? hardF[c1]! : hardB[c1]!;
        const h2 = curLayer === 0 ? hardF[c2]! : hardB[c2]!;
        if (h1 || h2) continue;
        if (!allowSoft) {
          const d1 = curLayer === 0 ? dynOwnerF[c1]! : dynOwnerB[c1]!;
          const d2 = curLayer === 0 ? dynOwnerF[c2]! : dynOwnerB[c2]!;
          if (d1 !== 0 || d2 !== 0) continue;
        }
      }

      const stepMm = STEP_LEN[d]! * grid;
      const isOwn = curLayer === 0 ? ownF[nCell]! : ownB[nCell]!;
      let moveCost = isOwn ? stepMm * 0.15 : stepMm;

      // Layer preference (F prefers horizontal, B prefers vertical, slight F bias)
      if (curLayer === 0) {
        if (DY[d] !== 0) moveCost += stepMm * 0.04;
      } else {
        moveCost += stepMm * 0.02;
        if (DX[d] !== 0) moveCost += stepMm * 0.04;
      }

      // Bend penalty
      if (prevDir >= 0 && prevDir !== d) {
        const diff = Math.abs(prevDir - d);
        const turn = Math.min(diff, 8 - diff);
        moveCost += turn === 1 ? bend45Cost : bend90Cost;
      }

      if (dynOwner !== 0 && dynOwner !== netSlot) {
        moveCost += softPenalty + ctx.history[nKey]! * historyWeight;
      }

      const ng = curG + moveCost;
      if (ng < gScore[nKey]! - 1e-9) {
        gScore[nKey] = ng;
        parent[nKey] = curKey;
        parentDir[nKey] = d;
        heap.push(nKey, ng + heuristic(nx, ny));
      }
    }

    // Via transition F <-> B at current (gx, gy)
    if (!hardVia[cellIdx]!) {
      const dynVia = dynOwnerVia[cellIdx]!;
      if (allowSoft || dynVia === 0) {
        const otherLayer: 0 | 1 = curLayer === 0 ? 1 : 0;
        const nKey = otherLayer * size + cellIdx;
        if (!closed[nKey]!) {
          const otherHard = otherLayer === 0 ? hardF[cellIdx]! : hardB[cellIdx]!;
          const otherDyn = otherLayer === 0 ? dynOwnerF[cellIdx]! : dynOwnerB[cellIdx]!;
          if (!otherHard && (allowSoft || otherDyn === 0)) {
            let vCost = viaCost;
            if (ownPad[cellIdx]!) vCost += viaOnPadCost;
            if (dynVia !== 0 && dynVia !== netSlot) {
              vCost += softPenalty + ctx.history[nKey]! * historyWeight;
            }
            if (otherDyn !== 0 && otherDyn !== netSlot) {
              vCost += softPenalty + ctx.history[nKey]! * historyWeight;
            }
            const ng = curG + vCost;
            if (ng < gScore[nKey]! - 1e-9) {
              gScore[nKey] = ng;
              parent[nKey] = curKey;
              parentDir[nKey] = -1;
              heap.push(nKey, ng + heuristic(gx, gy));
            }
          }
        }
      }
    }
  }

  if (goalKey < 0) return undefined;

  // Reconstruct state path
  const revPath: number[] = [];
  let cur = goalKey;
  while (cur >= 0) {
    revPath.push(cur);
    cur = parent[cur]!;
  }
  revPath.reverse();

  const crossedSlots = new Set<number>();
  const contestedStates: number[] = [];
  for (const sk of revPath) {
    const l: 0 | 1 = sk >= size ? 1 : 0;
    const ci = l === 1 ? sk - size : sk;
    const owner = l === 0 ? dynOwnerF[ci]! : dynOwnerB[ci]!;
    if (owner !== 0 && owner !== netSlot) {
      crossedSlots.add(owner);
      contestedStates.push(sk);
    }
    const viaOwner = dynOwnerVia[ci]!;
    if (viaOwner !== 0 && viaOwner !== netSlot) {
      crossedSlots.add(viaOwner);
      contestedStates.push(sk);
    }
  }
  if (allowSoft && crossedSlots.size > 0) {
    return { tracks: [], vias: [], goalKey, crossedSlots, contestedStates };
  }

  // Convert state path into tracks + vias
  const startInfo = startTargets.cells.get(revPath[0]!)!;
  const endInfo = endTargets.cells.get(revPath[revPath.length - 1]!)!;

  const statePoint = (sk: number): Point => {
    const ci = sk % size;
    const gy = Math.floor(ci / cols);
    const gx = ci - gy * cols;
    return [roundMm(ox + gx * grid, 4), roundMm(oy + gy * grid, 4)];
  };

  const runs: { layer: PcbLayer; pts: Point[] }[] = [];
  const vias: PcbVia[] = [];
  let curLayer: PcbLayer = revPath[0]! >= size ? 'B' : 'F';
  let curPts: Point[] = [];

  if (Math.hypot(startInfo.anchor[0] - statePoint(revPath[0]!)[0], startInfo.anchor[1] - statePoint(revPath[0]!)[1]) > 1e-5) {
    curPts.push([roundMm(startInfo.anchor[0], 4), roundMm(startInfo.anchor[1], 4)]);
  }
  curPts.push(statePoint(revPath[0]!));

  for (let i = 1; i < revPath.length; i++) {
    const prevSk = revPath[i - 1]!;
    const sk = revPath[i]!;
    const prevL: PcbLayer = prevSk >= size ? 'B' : 'F';
    const nextL: PcbLayer = sk >= size ? 'B' : 'F';
    const pt = statePoint(sk);

    if (prevL !== nextL) {
      if (curPts.length >= 2) runs.push({ layer: curLayer, pts: curPts });
      vias.push({
        net: netId,
        at: [pt[0], pt[1]],
        size: rules.via,
        drill: rules.drill,
      });
      curLayer = nextL;
      curPts = [pt];
    } else {
      curPts.push(pt);
    }
  }

  const lastPt = statePoint(revPath[revPath.length - 1]!);
  if (Math.hypot(endInfo.anchor[0] - lastPt[0], endInfo.anchor[1] - lastPt[1]) > 1e-5) {
    curPts.push([roundMm(endInfo.anchor[0], 4), roundMm(endInfo.anchor[1], 4)]);
  }
  if (curPts.length >= 2) runs.push({ layer: curLayer, pts: curPts });

  const tracks: PcbTrack[] = [];
  for (const r of runs) {
    const simp = simplifyTrackPoints(r.pts, r.layer, rules.track, netId, ctx, dynRoutes);
    if (simp.length >= 2) {
      tracks.push({
        net: netId,
        layer: r.layer,
        width: rules.track,
        points: simp,
      });
    }
  }

  return { tracks, vias, goalKey, crossedSlots, contestedStates };
}

function buildDynamicRoute(
  netId: string,
  tracks: PcbTrack[],
  vias: PcbVia[],
  ctx: GridCtx,
): DynamicRoute {
  const { grid, ox, oy, cols, rows, rules } = ctx;
  const trackHalf = rules.track / 2;
  const viaHalf = rules.via / 2;
  const trackExp = trackHalf + trackHalf + rules.clearance + ctx.segMargin;
  const viaExpFromTrack = viaHalf + trackHalf + rules.clearance + 1e-4;
  const viaExpFromVia = viaHalf + viaHalf + rules.clearance + 1e-4;

  const shapes: Obstacle[] = [];
  const fSet = new Set<number>();
  const bSet = new Set<number>();
  const vSet = new Set<number>();

  for (const t of tracks) {
    for (let i = 0; i < t.points.length - 1; i++) {
      const a = t.points[i]!;
      const b = t.points[i + 1]!;
      const sh = segmentToShape(a[0], a[1], b[0], b[1], t.width, t.layer);
      shapes.push({ netKey: netId, shape: sh });
      const tCells = rasterizeShape(sh, trackExp, grid, ox, oy, cols, rows);
      const targetSet = t.layer === 'F' ? fSet : bSet;
      for (const c of tCells) targetSet.add(c);
      const vCells = rasterizeShape(sh, viaExpFromTrack, grid, ox, oy, cols, rows);
      for (const c of vCells) vSet.add(c);
    }
  }

  for (const v of vias) {
    const sh = viaToShape(v);
    shapes.push({ netKey: netId, shape: sh });
    const tCells = rasterizeShape(sh, trackHalf + viaHalf + rules.clearance + ctx.segMargin, grid, ox, oy, cols, rows);
    for (const c of tCells) { fSet.add(c); bSet.add(c); }
    const vCells = rasterizeShape(sh, viaExpFromVia, grid, ox, oy, cols, rows);
    for (const c of vCells) vSet.add(c);
  }

  return {
    netId,
    tracks,
    vias,
    shapes,
    cellsF: [...fSet],
    cellsB: [...bSet],
    cellsVia: [...vSet],
  };
}

function populateObstaclesForNet(
  netId: string,
  netSlot: number,
  islands: NetIsland[],
  ctx: GridCtx,
  dynRoutes: Map<number, DynamicRoute>,
  hardF: Uint8Array,
  hardB: Uint8Array,
  hardVia: Uint8Array,
  dynOwnerF: Int32Array,
  dynOwnerB: Int32Array,
  dynOwnerVia: Int32Array,
  ownF: Uint8Array,
  ownB: Uint8Array,
  ownPad: Uint8Array,
): void {
  hardF.set(ctx.baseF);
  hardB.set(ctx.baseB);
  hardVia.set(ctx.baseVia);
  dynOwnerF.fill(0);
  dynOwnerB.fill(0);
  dynOwnerVia.fill(0);
  ownF.fill(0);
  ownB.fill(0);
  ownPad.fill(0);

  const { grid, ox, oy, cols, rows, rules } = ctx;
  const trackHalf = rules.track / 2;
  const viaHalf = rules.via / 2;

  for (const ps of ctx.padStamps) {
    if (ps.netKey === netId) continue;
    if (ps.layers.includes('F')) for (const c of ps.blockTrackCells) hardF[c] = 1;
    if (ps.layers.includes('B')) for (const c of ps.blockTrackCells) hardB[c] = 1;
    for (const c of ps.blockViaCells) hardVia[c] = 1;
  }

  for (const obs of ctx.fixedObstacles) {
    if (obs.netKey === netId) continue;
    const tCells = rasterizeShape(obs.shape, trackHalf + obs.shape.r + rules.clearance + ctx.segMargin, grid, ox, oy, cols, rows);
    if (obs.shape.layers.includes('F')) for (const c of tCells) hardF[c] = 1;
    if (obs.shape.layers.includes('B')) for (const c of tCells) hardB[c] = 1;
    const vCells = rasterizeShape(obs.shape, viaHalf + obs.shape.r + rules.clearance + 1e-4, grid, ox, oy, cols, rows);
    for (const c of vCells) hardVia[c] = 1;
  }

  for (const [slot, dr] of dynRoutes) {
    if (slot === netSlot) continue;
    for (const c of dr.cellsF) dynOwnerF[c] = slot;
    for (const c of dr.cellsB) dynOwnerB[c] = slot;
    for (const c of dr.cellsVia) dynOwnerVia[c] = slot;
  }

  for (const isl of islands) {
    for (const item of isl.items) {
      const cells = rasterizeShape(item.shape, 1e-4, grid, ox, oy, cols, rows);
      if (item.shape.layers.includes('F')) for (const c of cells) ownF[c] = 1;
      if (item.shape.layers.includes('B')) for (const c of cells) ownB[c] = 1;
      if (item.kind === 'pad') for (const c of cells) ownPad[c] = 1;
    }
  }
}

function mergeIslandsWithTracks(
  islands: NetIsland[],
  net: Net,
  newTracks: PcbTrack[],
  newVias: PcbVia[],
  idxA: number,
  idxB: number,
): NetIsland[] {
  const a = islands[idxA]!;
  const b = islands[idxB]!;
  const mergedItems: CopperItem[] = [...a.items, ...b.items];
  const mergedAnchors: Anchor[] = [...a.anchors, ...b.anchors];

  for (let ti = 0; ti < newTracks.length; ti++) {
    const t = newTracks[ti]!;
    for (let si = 0; si < t.points.length - 1; si++) {
      const p1 = t.points[si]!;
      const p2 = t.points[si + 1]!;
      const anc: Anchor[] = [
        { at: p1, key: `rt:${ti}:${si}:${p1[0]},${p1[1]}` },
        { at: p2, key: `rt:${ti}:${si + 1}:${p2[0]},${p2[1]}` },
      ];
      mergedAnchors.push(...anc);
      mergedItems.push({
        kind: 'track',
        objectKey: `rt:${ti}`,
        netKey: net.id,
        netId: net.id,
        netName: net.name,
        label: `track ${net.name} (${t.layer})`,
        shape: segmentToShape(p1[0], p1[1], p2[0], p2[1], t.width, t.layer),
        anchors: anc,
      });
    }
  }
  for (let vi = 0; vi < newVias.length; vi++) {
    const v = newVias[vi]!;
    const anc: Anchor = { at: v.at, key: `rv:${vi}:${v.at[0]},${v.at[1]}` };
    mergedAnchors.push(anc);
    mergedItems.push({
      kind: 'via',
      objectKey: `rv:${vi}`,
      netKey: net.id,
      netId: net.id,
      netName: net.name,
      label: `via ${net.name}`,
      shape: viaToShape(v),
      anchors: [anc],
    });
  }

  const next: NetIsland[] = [];
  for (let i = 0; i < islands.length; i++) {
    if (i === idxA || i === idxB) continue;
    next.push(islands[i]!);
  }
  next.push({ key: a.key, items: mergedItems, anchors: mergedAnchors });
  next.sort((x, y) => naturalCompare(x.key, y.key));
  return next;
}

function closestIslandPair(islands: NetIsland[]): [number, number] {
  let bestDist = Infinity;
  let bestA = 0;
  let bestB = 1;
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      for (const a of islands[i]!.anchors) {
        for (const b of islands[j]!.anchors) {
          const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
          if (d < bestDist - 1e-9) {
            bestDist = d;
            bestA = i;
            bestB = j;
          }
        }
      }
    }
  }
  return [bestA, bestB];
}

function buildPairEndpoints(
  islands: NetIsland[],
  startIdx: number,
  netId: string,
  ctx: GridCtx,
  buffers: { hardF: Uint8Array; hardB: Uint8Array; dynOwnerF: Int32Array; dynOwnerB: Int32Array },
  dynRoutes: Map<number, DynamicRoute>,
  allowSoft: boolean,
): {
  startTargets: IslandGridTargets;
  endTargets: IslandGridTargets;
  otherMap: Map<number, { islandIdx: number; info: { anchor: Point; dist: number; inside: boolean } }>;
} {
  const startTargets = collectIslandGridNodes(
    islands[startIdx]!, netId, ctx, buffers.hardF, buffers.hardB, buffers.dynOwnerF, buffers.dynOwnerB, dynRoutes, allowSoft,
  );
  const otherMap = new Map<number, { islandIdx: number; info: { anchor: Point; dist: number; inside: boolean } }>();
  const otherAnchors: Anchor[] = [];
  let oMinX = Infinity, oMinY = Infinity, oMaxX = -Infinity, oMaxY = -Infinity;

  for (let i = 0; i < islands.length; i++) {
    if (i === startIdx) continue;
    const t = collectIslandGridNodes(
      islands[i]!, netId, ctx, buffers.hardF, buffers.hardB, buffers.dynOwnerF, buffers.dynOwnerB, dynRoutes, allowSoft,
    );
    otherAnchors.push(...t.anchors);
    oMinX = Math.min(oMinX, t.bbox.minX);
    oMinY = Math.min(oMinY, t.bbox.minY);
    oMaxX = Math.max(oMaxX, t.bbox.maxX);
    oMaxY = Math.max(oMaxY, t.bbox.maxY);
    for (const [k, info] of t.cells) {
      const prev = otherMap.get(k);
      if (!prev || (info.inside && !prev.info.inside) || (info.inside === prev.info.inside && info.dist < prev.info.dist)) {
        otherMap.set(k, { islandIdx: i, info });
      }
    }
  }
  return {
    startTargets,
    endTargets: {
      cells: new Map([...otherMap.entries()].map(([k, v]) => [k, v.info])),
      anchors: otherAnchors,
      bbox: { minX: oMinX, minY: oMinY, maxX: oMaxX, maxY: oMaxY },
    },
    otherMap,
  };
}

function routeSingleNet(
  target: TargetNet,
  ctx: GridCtx,
  dynRoutes: Map<number, DynamicRoute>,
  buffers: {
    hardF: Uint8Array;
    hardB: Uint8Array;
    hardVia: Uint8Array;
    dynOwnerF: Int32Array;
    dynOwnerB: Int32Array;
    dynOwnerVia: Int32Array;
    ownF: Uint8Array;
    ownB: Uint8Array;
    ownPad: Uint8Array;
    scratch: SearchScratch;
  },
  allowSoftOnFail: boolean,
): {
  ok: boolean;
  tracks: PcbTrack[];
  vias: PcbVia[];
  crossedSlots: Set<number>;
  contestedStates: number[];
} {
  let islands = target.islands.map(i => ({ ...i, items: [...i.items], anchors: [...i.anchors] }));
  const netTracks: PcbTrack[] = [];
  const netVias: PcbVia[] = [];
  const crossedSlots = new Set<number>();
  const contestedStates: number[] = [];

  while (islands.length > 1) {
    populateObstaclesForNet(
      target.net.id,
      target.slot,
      islands,
      ctx,
      dynRoutes,
      buffers.hardF,
      buffers.hardB,
      buffers.hardVia,
      buffers.dynOwnerF,
      buffers.dynOwnerB,
      buffers.dynOwnerVia,
      buffers.ownF,
      buffers.ownB,
      buffers.ownPad,
    );

    const [ia, ib] = closestIslandPair(islands);
    const startIdx = islands[ia]!.items.length <= islands[ib]!.items.length ? ia : ib;

    const strict = buildPairEndpoints(islands, startIdx, target.net.id, ctx, buffers, dynRoutes, false);
    const res = runAStar(
      target.net.id, target.slot, strict.startTargets, strict.endTargets, ctx,
      buffers.hardF, buffers.hardB, buffers.hardVia, buffers.dynOwnerF, buffers.dynOwnerB, buffers.dynOwnerVia,
      buffers.ownF, buffers.ownB, buffers.ownPad, dynRoutes, buffers.scratch, false,
    );

    if (res) {
      const reachedIdx = strict.otherMap.get(res.goalKey)!.islandIdx;
      netTracks.push(...res.tracks);
      netVias.push(...res.vias);
      dynRoutes.set(target.slot, buildDynamicRoute(target.net.id, netTracks, netVias, ctx));
      islands = mergeIslandsWithTracks(islands, target.net, res.tracks, res.vias, startIdx, reachedIdx);
      continue;
    }

    if (allowSoftOnFail) {
      const soft = buildPairEndpoints(islands, startIdx, target.net.id, ctx, buffers, dynRoutes, true);
      const softRes = runAStar(
        target.net.id, target.slot, soft.startTargets, soft.endTargets, ctx,
        buffers.hardF, buffers.hardB, buffers.hardVia, buffers.dynOwnerF, buffers.dynOwnerB, buffers.dynOwnerVia,
        buffers.ownF, buffers.ownB, buffers.ownPad, dynRoutes, buffers.scratch, true,
      );
      if (softRes) {
        for (const s of softRes.crossedSlots) crossedSlots.add(s);
        contestedStates.push(...softRes.contestedStates);
      }
    }

    return { ok: false, tracks: netTracks, vias: netVias, crossedSlots, contestedStates };
  }

  return { ok: true, tracks: netTracks, vias: netVias, crossedSlots, contestedStates };
}

/** Autoroute unrouted PCB connections on F/B copper layers with vias. */
export function route(q: Query, opts?: RouteOptions): RouteResult {
  const rules: PcbRules = { ...DEFAULT_PCB_RULES, ...q.circuit.pcb?.rules };
  const grid = opts?.grid ?? defaultGridSize(rules);
  if (!Number.isFinite(grid) || grid <= 0) {
    throw new Error(`invalid route grid "${String(grid)}"`);
  }

  const wantedNames = opts?.nets?.length
    ? new Set(opts.nets.map(n => n.toUpperCase()))
    : undefined;

  const ignoreNetIds = new Set<string>();
  const notes: string[] = [];
  if (wantedNames) {
    for (const raw of opts!.nets!) {
      const n = q.net(raw);
      if (!n) notes.push(`unknown net ${raw}`);
    }
  }

  if (opts?.reroute) {
    for (const net of q.nets()) {
      if (!wantedNames || wantedNames.has(net.name.toUpperCase())) {
        ignoreNetIds.add(net.id);
      }
    }
  }

  const analysis = analyzeConnectivity(q, {
    ...(opts?.pads ? { pads: opts.pads } : {}),
    ...(ignoreNetIds.size > 0 ? { ignoreNetIds } : {}),
  });

  const targetNets: TargetNet[] = [];
  const fixedItems: CopperItem[] = [];

  for (const item of analysis.items) {
    // Pads are stored in padStamps; only non-target pre-existing tracks/vias are fixed obstacles
    if (item.kind === 'pad') {
      fixedItems.push(item);
      continue;
    }
    const net = item.netId ? q.circuit.nets[item.netId] : undefined;
    const isSelected = net !== undefined && (!wantedNames || wantedNames.has(net.name.toUpperCase()));
    if (!isSelected) {
      fixedItems.push(item);
    } else {
      // Existing tracks/vias on target nets when reroute=false stay as fixed obstacles for other nets
      // AND remain part of the target net's islands (never modified or returned in new tracks/vias).
      fixedItems.push(item);
    }
  }

  let slotCounter = 1;
  for (const net of q.nets()) {
    if (wantedNames && !wantedNames.has(net.name.toUpperCase())) continue;
    const nc = analysis.byNet.get(net.id);
    if (!nc || nc.islands.length <= 1) continue;
    const mstLen = nc.ratsnest.reduce((s, c) => s + Math.hypot(c.to[0] - c.from[0], c.to[1] - c.from[1]), 0);
    targetNets.push({
      net,
      slot: slotCounter++,
      islands: nc.islands,
      mstLen,
    });
  }

  if (targetNets.length === 0) {
    return { tracks: [], vias: [], unrouted: [], notes };
  }

  // Order short, low-fanout nets first; longer / high-fanout power nets last.
  targetNets.sort((a, b) =>
    a.islands.length - b.islands.length
    || (Math.abs(a.mstLen - b.mstLen) > 1e-6 ? a.mstLen - b.mstLen : 0)
    || naturalCompare(a.net.name, b.net.name),
  );

  const ctx = buildGridCtx(q, analysis.pads, fixedItems, rules, grid);
  const buffers = {
    hardF: new Uint8Array(ctx.size),
    hardB: new Uint8Array(ctx.size),
    hardVia: new Uint8Array(ctx.size),
    dynOwnerF: new Int32Array(ctx.size),
    dynOwnerB: new Int32Array(ctx.size),
    dynOwnerVia: new Int32Array(ctx.size),
    ownF: new Uint8Array(ctx.size),
    ownB: new Uint8Array(ctx.size),
    ownPad: new Uint8Array(ctx.size),
    scratch: makeScratch(ctx.size * 2),
  };

  const slotToTarget = new Map<number, TargetNet>();
  for (const t of targetNets) slotToTarget.set(t.slot, t);

  let order = targetNets.map(t => t.slot);
  const dynRoutes = new Map<number, DynamicRoute>();

  interface Snapshot {
    routes: Map<number, { tracks: PcbTrack[]; vias: PcbVia[] }>;
    unrouted: string[];
    viasCount: number;
    wireLen: number;
  }

  const measureSnapshot = (unroutedList: string[]): Snapshot => {
    const routes = new Map<number, { tracks: PcbTrack[]; vias: PcbVia[] }>();
    let viasCount = 0;
    let wireLen = 0;
    for (const [slot, dr] of dynRoutes) {
      routes.set(slot, { tracks: dr.tracks, vias: dr.vias });
      viasCount += dr.vias.length;
      for (const t of dr.tracks) {
        for (let i = 0; i < t.points.length - 1; i++) {
          wireLen += Math.hypot(t.points[i + 1]![0] - t.points[i]![0], t.points[i + 1]![1] - t.points[i]![1]);
        }
      }
    }
    return { routes, unrouted: unroutedList, viasCount, wireLen };
  };

  let best: Snapshot | undefined;
  const maxRounds = Math.min(12, Math.max(4, targetNets.length * 2));
  let ripups = 0;

  for (let round = 0; round < maxRounds; round++) {
    const failed: { slot: number; crossed: Set<number>; contested: number[] }[] = [];

    for (const slot of order) {
      if (dynRoutes.has(slot)) continue;
      const target = slotToTarget.get(slot)!;
      const res = routeSingleNet(target, ctx, dynRoutes, buffers, true);
      if (res.ok) {
        dynRoutes.set(slot, buildDynamicRoute(target.net.id, res.tracks, res.vias, ctx));
      } else {
        dynRoutes.delete(slot);
        // Keep partial tracks only if we hit final round? For now keep clean and re-try after rip-up
        failed.push({ slot, crossed: res.crossedSlots, contested: res.contestedStates });
      }
    }

    const unroutedNames = failed
      .map(f => slotToTarget.get(f.slot)!.net.name)
      .sort(naturalCompare);
    const snap = measureSnapshot(unroutedNames);
    if (
      !best
      || snap.unrouted.length < best.unrouted.length
      || (snap.unrouted.length === best.unrouted.length
        && (snap.viasCount < best.viasCount
          || (snap.viasCount === best.viasCount && snap.wireLen < best.wireLen - 1e-4)))
    ) {
      best = snap;
    }

    if (failed.length === 0) break;

    // Rip up blocking nets and promote failed nets
    const ripSet = new Set<number>();
    const promote: number[] = [];
    for (const f of failed) {
      promote.push(f.slot);
      for (const st of f.contested) ctx.history[st] = ctx.history[st]! + 1;
      for (const cs of f.crossed) ripSet.add(cs);
    }

    if (ripSet.size === 0) {
      // Even soft A* couldn't bypass fixed obstacles; keep any partial tracks for unrouted net on best attempt
      break;
    }

    ripups += 1;
    for (const rs of ripSet) dynRoutes.delete(rs);

    const promoteSet = new Set(promote);
    const rest = order.filter(s => !promoteSet.has(s) && !ripSet.has(s));
    const ripped = order.filter(s => ripSet.has(s) && !promoteSet.has(s));
    order = [...promote, ...ripped, ...rest];
  }

  // Emit tracks and vias in deterministic net order
  const outTracks: PcbTrack[] = [];
  const outVias: PcbVia[] = [];
  for (const net of q.nets()) {
    const t = targetNets.find(x => x.net.id === net.id);
    if (!t) continue;
    const r = best?.routes.get(t.slot);
    if (!r) continue;
    outTracks.push(...r.tracks);
    outVias.push(...r.vias);
  }

  const unrouted = best?.unrouted ?? [];
  if (ripups > 0) notes.push(`rip-up rounds: ${ripups}`);
  notes.push(`grid ${grid} mm`);

  return {
    tracks: outTracks,
    vias: outVias,
    unrouted,
    notes,
  };
}
