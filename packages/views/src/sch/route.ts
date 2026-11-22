// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Net, type PinKey, type Query } from '@cadllm/core';
import { el, path } from '../svg.ts';
import { UNIT } from '../types.ts';
import { isGroundNet, isPowerNet } from './nets.ts';
import { dirDelta } from './place.ts';
import type { Dir, GridBox, PlacedPin, PlacedSymbol } from './types.ts';

const DIRS: { dir: Dir; dx: number; dy: number; mask: number }[] = [
  { dir: 'R', dx: 1, dy: 0, mask: 1 },
  { dir: 'D', dx: 0, dy: 1, mask: 2 },
  { dir: 'L', dx: -1, dy: 0, mask: 1 },
  { dir: 'U', dx: 0, dy: -1, mask: 2 },
];

const keyPt = (x: number, y: number): string => `${x},${y}`;

function edgeKey(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 < x2 || (x1 === x2 && y1 < y2)) return `${x1},${y1}:${x2},${y2}`;
  return `${x2},${y2}:${x1},${y1}`;
}

interface HeapItem {
  f: number;
  g: number;
  x: number;
  y: number;
  dirIdx: number; // 0..3, or 4 = start
  parent: number;
}

class MinHeap {
  private data: number[] = [];
  private items: HeapItem[];

  constructor(items: HeapItem[]) {
    this.items = items;
  }

  get size(): number {
    return this.data.length;
  }

  push(idx: number): void {
    this.data.push(idx);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[this.data[p]!]!.f <= this.items[this.data[i]!]!.f) break;
      const tmp = this.data[p]!;
      this.data[p] = this.data[i]!;
      this.data[i] = tmp;
      i = p;
    }
  }

  pop(): number | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      const n = this.data.length;
      while (true) {
        let best = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && this.items[this.data[l]!]!.f < this.items[this.data[best]!]!.f) best = l;
        if (r < n && this.items[this.data[r]!]!.f < this.items[this.data[best]!]!.f) best = r;
        if (best === i) break;
        const tmp = this.data[i]!;
        this.data[i] = this.data[best]!;
        this.data[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

export interface RouteResult {
  /** SVG <g data-net="..."> strings. */
  netGroups: string[];
  /** Extra bounding box extent in grid units (power labels, GND symbols, wires). */
  bounds: GridBox | undefined;
  /** Pin pairs that fell back to ratsnest. */
  unroutable: { net: string; from: string; to: string }[];
}

interface Pt2 {
  x: number;
  y: number;
}

function expandBox(box: GridBox | undefined, x: number, y: number): GridBox {
  if (!box) return { minX: x, minY: y, maxX: x, maxY: y };
  return {
    minX: Math.min(box.minX, x),
    minY: Math.min(box.minY, y),
    maxX: Math.max(box.maxX, x),
    maxY: Math.max(box.maxY, y),
  };
}

function findPathAStar(
  start: PlacedPin,
  targets: Pt2[],
  bounds: GridBox,
  blocked: Set<string>,
  nearBody: Set<string>,
  otherPinCells: Set<string>,
  otherEdges: Set<string>,
  otherVertexMask: Map<string, number>,
  sameNetEdges: Set<string>,
): Pt2[] | undefined {
  const targetSet = new Set(targets.map(t => keyPt(t.x, t.y)));
  if (targetSet.has(keyPt(start.gx, start.gy))) return [{ x: start.gx, y: start.gy }];

  const h = (x: number, y: number): number => {
    let best = Infinity;
    for (const t of targets) {
      const d = Math.abs(x - t.x) + Math.abs(y - t.y);
      if (d < best) best = d;
    }
    return best * 10;
  };

  const items: HeapItem[] = [{ f: h(start.gx, start.gy), g: 0, x: start.gx, y: start.gy, dirIdx: 4, parent: -1 }];
  const heap = new MinHeap(items);
  heap.push(0);

  const bestCost = new Map<string, number>();
  bestCost.set(`${start.gx},${start.gy},4`, 0);

  const maxExpand = 15000;
  let expanded = 0;

  while (heap.size > 0 && expanded < maxExpand) {
    const curIdx = heap.pop()!;
    const cur = items[curIdx]!;
    const sk = `${cur.x},${cur.y},${cur.dirIdx}`;
    if (cur.g > (bestCost.get(sk) ?? Infinity)) continue;
    expanded++;

    if (cur.dirIdx !== 4 && targetSet.has(keyPt(cur.x, cur.y))) {
      // Cannot finish on a cell crossed by another net unless it's already a target.
      const out: Pt2[] = [];
      let p = curIdx;
      while (p !== -1) {
        const it = items[p]!;
        out.push({ x: it.x, y: it.y });
        p = it.parent;
      }
      out.reverse();
      return out;
    }

    // If we stepped onto another net's straight wire, we MUST continue straight!
    const curCellKey = keyPt(cur.x, cur.y);
    const curOtherMask = cur.dirIdx !== 4 ? (otherVertexMask.get(curCellKey) ?? 0) : 0;

    for (let dIdx = 0; dIdx < 4; dIdx++) {
      const d = DIRS[dIdx]!;
      if (cur.dirIdx !== 4 && (cur.dirIdx ^ 2) === dIdx) continue; // no 180-deg U-turn
      if (curOtherMask !== 0 && cur.dirIdx !== dIdx) continue; // must cross straight without bending

      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (nx < bounds.minX || nx > bounds.maxX || ny < bounds.minY || ny > bounds.maxY) continue;

      const nKey = keyPt(nx, ny);
      const isTarget = targetSet.has(nKey);

      if (!isTarget) {
        if (blocked.has(nKey) || otherPinCells.has(nKey)) continue;
      }

      const ek = edgeKey(cur.x, cur.y, nx, ny);
      if (otherEdges.has(ek)) continue;

      const nextOtherMask = otherVertexMask.get(nKey) ?? 0;
      if (nextOtherMask !== 0) {
        // Cannot touch another net's corner/T, and cannot enter parallel to it.
        if (nextOtherMask === 3) continue;
        if ((nextOtherMask & d.mask) !== 0) continue;
        if (isTarget) continue;
      }

      let stepCost = sameNetEdges.has(ek) ? 1 : 10;
      if (cur.dirIdx === 4) {
        if (d.dir !== start.dir) stepCost += 80;
      } else if (cur.dirIdx !== dIdx) {
        stepCost += 35;
      }
      if (nextOtherMask !== 0) stepCost += 250;
      if (!isTarget && nearBody.has(nKey)) stepCost += 8;

      const ng = cur.g + stepCost;
      const nStateKey = `${nx},${ny},${dIdx}`;
      if (ng < (bestCost.get(nStateKey) ?? Infinity)) {
        bestCost.set(nStateKey, ng);
        const idx = items.length;
        items.push({ f: ng + h(nx, ny), g: ng, x: nx, y: ny, dirIdx: dIdx, parent: curIdx });
        heap.push(idx);
      }
    }
  }

  return undefined;
}

function mergeSegments(edges: Set<string>): string[] {
  const horiz = new Map<number, [number, number][]>();
  const vert = new Map<number, [number, number][]>();

  for (const ek of edges) {
    const [a, b] = ek.split(':') as [string, string];
    const [x1, y1] = a.split(',').map(Number) as [number, number];
    const [x2, y2] = b.split(',').map(Number) as [number, number];
    if (y1 === y2) {
      const list = horiz.get(y1) ?? [];
      list.push([Math.min(x1, x2), Math.max(x1, x2)]);
      horiz.set(y1, list);
    } else {
      const list = vert.get(x1) ?? [];
      list.push([Math.min(y1, y2), Math.max(y1, y2)]);
      vert.set(x1, list);
    }
  }

  const paths: string[] = [];
  for (const y of [...horiz.keys()].sort((a, b) => a - b)) {
    const segs = horiz.get(y)!.sort((a, b) => a[0] - b[0]);
    let [curS, curE] = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
      const [s, e] = segs[i]!;
      if (s <= curE) curE = Math.max(curE, e);
      else {
        paths.push(path(['M', curS * UNIT, y * UNIT, 'L', curE * UNIT, y * UNIT]));
        curS = s;
        curE = e;
      }
    }
    paths.push(path(['M', curS * UNIT, y * UNIT, 'L', curE * UNIT, y * UNIT]));
  }

  for (const x of [...vert.keys()].sort((a, b) => a - b)) {
    const segs = vert.get(x)!.sort((a, b) => a[0] - b[0]);
    let [curS, curE] = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
      const [s, e] = segs[i]!;
      if (s <= curE) curE = Math.max(curE, e);
      else {
        paths.push(path(['M', x * UNIT, curS * UNIT, 'L', x * UNIT, curE * UNIT]));
        curS = s;
        curE = e;
      }
    }
    paths.push(path(['M', x * UNIT, curS * UNIT, 'L', x * UNIT, curE * UNIT]));
  }

  return paths;
}

function drawPowerPin(
  pp: PlacedPin,
  netName: string,
  isGnd: boolean,
  blocked: Set<string>,
  bounds: GridBox | undefined,
): { els: string[]; bounds: GridBox | undefined } {
  const els: string[] = [];
  const d = dirDelta(pp.dir);
  const px = pp.gx * UNIT;
  const py = pp.gy * UNIT;

  if (isGnd) {
    let bx: number;
    let by: number;
    if (pp.dir === 'D') {
      bx = px;
      by = py + UNIT;
      els.push(el('path', { d: path(['M', px, py, 'L', bx, by]), class: 'gnd-wire' }));
    } else if (pp.dir === 'L' || pp.dir === 'R') {
      const sx = px + d.x * UNIT;
      bx = sx;
      by = py + 8;
      els.push(el('path', { d: path(['M', px, py, 'L', sx, py, 'L', bx, by]), class: 'gnd-wire' }));
    } else {
      const stepX = !blocked.has(keyPt(pp.gx + 1, pp.gy - 1)) ? 1 : -1;
      const sx = px + stepX * UNIT;
      bx = sx;
      by = py + 4;
      els.push(el('path', { d: path(['M', px, py, 'L', px, py - 6, 'L', sx, py - 6, 'L', bx, by]), class: 'gnd-wire' }));
    }
    const bars = path([
      'M', bx - 7, by, 'L', bx + 7, by,
      'M', bx - 4.5, by + 3.5, 'L', bx + 4.5, by + 3.5,
      'M', bx - 2, by + 7, 'L', bx + 2, by + 7,
    ]);
    els.push(el('path', { d: bars, class: 'gnd-sym' }));
    if (netName.toUpperCase() !== 'GND') {
      els.push(el('text', { x: bx, y: by + 16, 'text-anchor': 'middle', class: 'gnd-lbl' }, netName));
    }
    const gx = bx / UNIT;
    const gy = by / UNIT;
    bounds = expandBox(bounds, gx - 0.8, gy);
    bounds = expandBox(bounds, gx + 0.8, gy + (netName.toUpperCase() !== 'GND' ? 1.8 : 0.9));
    return { els, bounds };
  }

  // Positive power flag / T-bar + net label.
  const ex = px + d.x * UNIT;
  const ey = py + d.y * UNIT;
  els.push(el('path', { d: path(['M', px, py, 'L', ex, ey]), class: 'pwr-wire' }));

  if (pp.dir === 'U' || pp.dir === 'D') {
    els.push(el('path', { d: path(['M', ex - 6, ey, 'L', ex + 6, ey]), class: 'pwr-sym' }));
    const ty = pp.dir === 'U' ? ey - 4 : ey + 10;
    els.push(el('text', { x: ex, y: ty, 'text-anchor': 'middle', class: 'pwr-lbl' }, netName));
    const gx = ex / UNIT;
    const gy = ey / UNIT;
    bounds = expandBox(bounds, gx - Math.max(0.8, netName.length * 0.3), gy + (pp.dir === 'U' ? -1.2 : 1.2));
    bounds = expandBox(bounds, gx + Math.max(0.8, netName.length * 0.3), gy);
  } else {
    els.push(el('path', { d: path(['M', ex, ey - 5, 'L', ex, ey + 5]), class: 'pwr-sym' }));
    const anchor = pp.dir === 'L' ? 'end' : 'start';
    const tx = ex + d.x * 4;
    els.push(el('text', { x: tx, y: ey + 2.5, 'text-anchor': anchor, class: 'pwr-lbl' }, netName));
    const gx = tx / UNIT;
    const gy = ey / UNIT;
    const w = Math.max(0.8, netName.length * 0.55);
    bounds = expandBox(bounds, pp.dir === 'L' ? gx - w : gx, gy - 0.6);
    bounds = expandBox(bounds, pp.dir === 'L' ? gx : gx + w, gy + 0.6);
  }
  return { els, bounds };
}

export function routeNets(
  q: Query,
  symbols: PlacedSymbol[],
  highlightedNets: Set<string>,
): RouteResult {
  const pinByKey = new Map<PinKey, PlacedPin>();
  const pinSymFamily = new Map<PinKey, string>();
  const blocked = new Set<string>();
  const nearBody = new Set<string>();
  const symPinCoords = new Set<string>();

  let overallBox: GridBox | undefined;

  for (const s of symbols) {
    overallBox = expandBox(overallBox, s.fullBox.minX, s.fullBox.minY);
    overallBox = expandBox(overallBox, s.fullBox.maxX, s.fullBox.maxY);
    for (const pp of s.pins) {
      pinByKey.set(pp.key, pp);
      pinSymFamily.set(pp.key, s.family);
      symPinCoords.add(keyPt(pp.gx, pp.gy));
    }
    for (const c of s.blockedCells) {
      blocked.add(keyPt(c.gx, c.gy));
    }
  }

  for (const bk of blocked) {
    const [bx, by] = bk.split(',').map(Number) as [number, number];
    for (const d of DIRS) {
      const nk = keyPt(bx + d.dx, by + d.dy);
      if (!blocked.has(nk) && !symPinCoords.has(nk)) nearBody.add(nk);
    }
  }

  const allPlacedPinsByNet = new Map<string, PlacedPin[]>();
  const cellToNetIds = new Map<string, Set<string>>();

  for (const [k, pp] of pinByKey) {
    const net = q.netOfPin(k);
    const netId = net ? net.id : '__unconnected__';
    const ck = keyPt(pp.gx, pp.gy);
    const set = cellToNetIds.get(ck) ?? new Set<string>();
    set.add(netId);
    cellToNetIds.set(ck, set);
    if (net) {
      const list = allPlacedPinsByNet.get(net.id) ?? [];
      list.push(pp);
      allPlacedPinsByNet.set(net.id, list);
    }
  }

  const bounds: GridBox = overallBox
    ? { minX: overallBox.minX - 10, minY: overallBox.minY - 10, maxX: overallBox.maxX + 10, maxY: overallBox.maxY + 10 }
    : { minX: -20, minY: -20, maxX: 20, maxY: 20 };

  const powerNets: Net[] = [];
  const longLabelNets: { net: Net; pins: PlacedPin[] }[] = [];
  const signalNets: { net: Net; pins: PlacedPin[]; span: number }[] = [];

  for (const net of q.nets()) {
    const pins = (allPlacedPinsByNet.get(net.id) ?? []).slice().sort((a, b) =>
      a.gx - b.gx || a.gy - b.gy || naturalCompare(a.label, b.label),
    );
    if (pins.length === 0) continue;
    if (isPowerNet(q, net)) {
      powerNets.push(net);
    } else if (pins.length >= 2) {
      const minX = Math.min(...pins.map(p => p.gx));
      const maxX = Math.max(...pins.map(p => p.gx));
      const minY = Math.min(...pins.map(p => p.gy));
      const maxY = Math.max(...pins.map(p => p.gy));
      const span = (maxX - minX) + (maxY - minY);
      if (span > 50) {
        longLabelNets.push({ net, pins });
      } else {
        signalNets.push({ net, pins, span });
      }
    }
  }

  signalNets.sort((a, b) => a.span - b.span || naturalCompare(a.net.name, b.net.name));

  const occupiedEdges = new Set<string>();
  const occupiedVertexMask = new Map<string, number>();
  const netGroupsMap = new Map<string, string>();
  const unroutable: { net: string; from: string; to: string }[] = [];
  let extraBounds: GridBox | undefined;

  // Route signal nets first so wire paths are reserved cleanly.
  for (const { net, pins } of signalNets) {
    const otherPinCells = new Set<string>();
    for (const [ck, netsHere] of cellToNetIds) {
      for (const nid of netsHere) {
        if (nid !== net.id) {
          otherPinCells.add(ck);
          break;
        }
      }
    }

    const netEdges = new Set<string>();
    const connectedPts: Pt2[] = [{ x: pins[0]!.gx, y: pins[0]!.gy }];
    const connectedSet = new Set<string>([keyPt(pins[0]!.gx, pins[0]!.gy)]);
    const remaining = pins.slice(1);
    const ratsnests: { from: PlacedPin; to: Pt2 }[] = [];

    while (remaining.length > 0) {
      // Pick remaining pin closest by Manhattan distance to connectedPts.
      let bestIdx = 0;
      let bestDist = Infinity;
      let closestTarget = connectedPts[0]!;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i]!;
        for (const tp of connectedPts) {
          const d = Math.abs(p.gx - tp.x) + Math.abs(p.gy - tp.y);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
            closestTarget = tp;
          }
        }
      }

      const pin = remaining.splice(bestIdx, 1)[0]!;
      const pathPts = findPathAStar(
        pin,
        connectedPts,
        bounds,
        blocked,
        nearBody,
        otherPinCells,
        occupiedEdges,
        occupiedVertexMask,
        netEdges,
      );

      if (!pathPts) {
        ratsnests.push({ from: pin, to: closestTarget });
        unroutable.push({ net: net.name, from: pin.label, to: `${closestTarget.x},${closestTarget.y}` });
        const pk = keyPt(pin.gx, pin.gy);
        if (!connectedSet.has(pk)) {
          connectedSet.add(pk);
          connectedPts.push({ x: pin.gx, y: pin.gy });
        }
        continue;
      }

      for (let i = 0; i < pathPts.length; i++) {
        const pt = pathPts[i]!;
        const pk = keyPt(pt.x, pt.y);
        if (!connectedSet.has(pk)) {
          connectedSet.add(pk);
          connectedPts.push(pt);
        }
        extraBounds = expandBox(extraBounds, pt.x, pt.y);
        if (i > 0) {
          const prev = pathPts[i - 1]!;
          const ek = edgeKey(prev.x, prev.y, pt.x, pt.y);
          netEdges.add(ek);
        }
      }
    }

    // Commit net edges into global occupancy maps.
    const vertexDeg = new Map<string, number>();
    for (const ek of netEdges) {
      occupiedEdges.add(ek);
      const [a, b] = ek.split(':') as [string, string];
      const [x1, y1] = a.split(',').map(Number) as [number, number];
      const [x2, y2] = b.split(',').map(Number) as [number, number];
      const mask = y1 === y2 ? 1 : 2;
      occupiedVertexMask.set(a, (occupiedVertexMask.get(a) ?? 0) | mask);
      occupiedVertexMask.set(b, (occupiedVertexMask.get(b) ?? 0) | mask);
      vertexDeg.set(a, (vertexDeg.get(a) ?? 0) + 1);
      vertexDeg.set(b, (vertexDeg.get(b) ?? 0) + 1);
    }

    const children: string[] = [];
    for (const d of mergeSegments(netEdges)) {
      children.push(el('path', { d, class: 'wire' }));
    }

    // Junction dots at T-joins and 4-way joins (or wire passing through a pin).
    const netPinCoords = new Set(pins.map(p => keyPt(p.gx, p.gy)));
    for (const vk of [...vertexDeg.keys()].sort()) {
      const deg = vertexDeg.get(vk)! + (netPinCoords.has(vk) ? 1 : 0);
      if (deg >= 3) {
        const [vx, vy] = vk.split(',').map(Number) as [number, number];
        children.push(el('circle', { cx: vx * UNIT, cy: vy * UNIT, r: 2.2, class: 'junc' }));
      }
    }

    for (const rn of ratsnests) {
      children.push(el('path', {
        d: path(['M', rn.from.gx * UNIT, rn.from.gy * UNIT, 'L', rn.to.x * UNIT, rn.to.y * UNIT]),
        class: 'ratsnest',
      }));
    }

    if (children.length > 0) {
      const hl = highlightedNets.has(net.name.toUpperCase()) ? 'hl' : undefined;
      netGroupsMap.set(net.name, el('g', { 'data-net': net.name, class: hl }, children));
    }
  }

  // Render power nets as power symbols / net labels at each non-power-symbol pin.
  for (const net of powerNets) {
    const pins = (allPlacedPinsByNet.get(net.id) ?? []).slice().sort((a, b) =>
      a.gx - b.gx || a.gy - b.gy || naturalCompare(a.label, b.label),
    );
    const isGnd = isGroundNet(q, net);
    const pwrSymPins = pins.filter(p => {
      const fam = pinSymFamily.get(p.key);
      return fam === 'vcc' || fam === 'gnd';
    });
    const normalPins = pins.filter(p => {
      const fam = pinSymFamily.get(p.key);
      return fam !== 'vcc' && fam !== 'gnd';
    });

    const children: string[] = [];
    // If there's an explicit vcc/gnd symbol close to one normal pin, connect it with a short wire.
    const connectedViaSymbol = new Set<PinKey>();
    for (const sp of pwrSymPins) {
      let bestPin: PlacedPin | undefined;
      let bestDist = Infinity;
      for (const np of normalPins) {
        const d = Math.abs(np.gx - sp.gx) + Math.abs(np.gy - sp.gy);
        if (d <= 4 && d < bestDist) {
          bestDist = d;
          bestPin = np;
        }
      }
      if (bestPin && bestDist > 0) {
        connectedViaSymbol.add(bestPin.key);
        const midX = sp.gx;
        const midY = bestPin.gy;
        const dStr = sp.gx === bestPin.gx || sp.gy === bestPin.gy
          ? path(['M', bestPin.gx * UNIT, bestPin.gy * UNIT, 'L', sp.gx * UNIT, sp.gy * UNIT])
          : path(['M', bestPin.gx * UNIT, bestPin.gy * UNIT, 'L', midX * UNIT, midY * UNIT, 'L', sp.gx * UNIT, sp.gy * UNIT]);
        children.push(el('path', { d: dStr, class: isGnd ? 'gnd-wire' : 'pwr-wire' }));
      } else if (bestPin && bestDist === 0) {
        connectedViaSymbol.add(bestPin.key);
      }
    }

    for (const pp of normalPins) {
      if (connectedViaSymbol.has(pp.key)) continue;
      const res = drawPowerPin(pp, net.name, isGnd, blocked, extraBounds);
      children.push(...res.els);
      extraBounds = res.bounds;
    }

    if (children.length > 0) {
      const hl = highlightedNets.has(net.name.toUpperCase()) ? 'hl' : undefined;
      netGroupsMap.set(net.name, el('g', { 'data-net': net.name, class: hl }, children));
    }
  }

  // Render very long non-power nets as net labels at each pin to keep schematics readable.
  for (const { net, pins } of longLabelNets) {
    const children: string[] = [];
    for (const pp of pins) {
      const res = drawPowerPin(pp, net.name, false, blocked, extraBounds);
      children.push(...res.els);
      extraBounds = res.bounds;
    }
    if (children.length > 0) {
      const hl = highlightedNets.has(net.name.toUpperCase()) ? 'hl' : undefined;
      netGroupsMap.set(net.name, el('g', { 'data-net': net.name, class: hl }, children));
    }
  }

  const netGroups = [...netGroupsMap.keys()]
    .sort(naturalCompare)
    .map(name => netGroupsMap.get(name)!);

  return { netGroups, bounds: extraBounds, unroutable };
}
