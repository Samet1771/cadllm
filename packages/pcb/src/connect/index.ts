// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Net, type Query } from '@cadllm/core';
import { pads as resolvePads } from '../place/index.ts';
import type { ConnectOptions, Connection, PadInstance, Point, Ratsnest } from '../types.ts';
import { fmtMm, layersOverlap, padToShape, segmentToShape, shapeDistAndPoint, viaToShape, type CopperShape } from './geom.ts';

const CONNECT_EPS = 1e-4;

export interface Anchor {
  at: Point;
  pin?: string;
  key: string;
}

export interface CopperItem {
  kind: 'pad' | 'track' | 'via';
  /** Object identity for deduplicating DRC issues (e.g. multi-segment tracks). */
  objectKey: string;
  /** Net id for netlisted copper, or synthetic unique key for unconnected pads. */
  netKey: string;
  netId?: string;
  netName: string;
  label: string;
  shape: CopperShape;
  pad?: PadInstance;
  trackIndex?: number;
  viaIndex?: number;
  anchors: Anchor[];
}

export interface NetIsland {
  key: string;
  items: CopperItem[];
  anchors: Anchor[];
}

export interface NetConnectivity {
  net: Net;
  items: CopperItem[];
  islands: NetIsland[];
  ratsnest: Connection[];
}

export interface ConnectivityAnalysis {
  pads: PadInstance[];
  items: CopperItem[];
  byNet: Map<string, NetConnectivity>;
  ratsnest: Ratsnest;
}

function cmpAnchor(a: Anchor, b: Anchor): number {
  const pa = a.pin ? 0 : 1;
  const pb = b.pin ? 0 : 1;
  if (pa !== pb) return pa - pb;
  return naturalCompare(a.key, b.key);
}

function sortAnchors(anchors: Anchor[]): Anchor[] {
  return [...anchors].sort(cmpAnchor);
}

function resolveNetForPad(q: Query, pad: PadInstance): Net | undefined {
  if (pad.netId) {
    const byId = q.circuit.nets[pad.netId];
    if (byId) return byId;
  }
  if (pad.net) return q.net(pad.net);
  return undefined;
}

function computeIslandsAndMst(net: Net, netItems: CopperItem[]): { islands: NetIsland[]; ratsnest: Connection[] } {
  const n = netItems.length;
  if (n === 0) return { islands: [], ratsnest: [] };

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Merge segments of the same track object and pads sharing the same logical (compId, pinId).
  const byPin = new Map<string, number>();
  const byTrack = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const item = netItems[i]!;
    if (item.pad?.compId && item.pad.pinId) {
      const k = `${item.pad.compId}:${item.pad.pinId}`;
      const prev = byPin.get(k);
      if (prev !== undefined) union(i, prev);
      else byPin.set(k, i);
    }
    if (item.trackIndex !== undefined) {
      const prev = byTrack.get(item.trackIndex);
      if (prev !== undefined) union(i, prev);
      else byTrack.set(item.trackIndex, i);
    }
  }

  // Merge physically touching/overlapping copper on matching layers.
  for (let i = 0; i < n; i++) {
    const a = netItems[i]!;
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const b = netItems[j]!;
      if (
        a.shape.maxX + CONNECT_EPS < b.shape.minX
        || b.shape.maxX + CONNECT_EPS < a.shape.minX
        || a.shape.maxY + CONNECT_EPS < b.shape.minY
        || b.shape.maxY + CONNECT_EPS < a.shape.minY
      ) {
        continue;
      }
      if (layersOverlap(a.shape.layers, b.shape.layers).length === 0) continue;
      if (shapeDistAndPoint(a.shape, b.shape).dist <= CONNECT_EPS) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, CopperItem[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(netItems[i]!);
    groups.set(r, list);
  }

  const islands: NetIsland[] = [];
  for (const group of groups.values()) {
    const rawAnchors: Anchor[] = [];
    for (const item of group) rawAnchors.push(...item.anchors);
    const anchors = sortAnchors(rawAnchors);
    islands.push({
      key: anchors[0]?.key ?? group[0]!.objectKey,
      items: group,
      anchors,
    });
  }
  islands.sort((a, b) => naturalCompare(a.key, b.key));

  if (islands.length <= 1) return { islands, ratsnest: [] };

  interface MstEdge {
    u: number;
    v: number;
    dist: number;
    from: Anchor;
    to: Anchor;
  }

  const edges: MstEdge[] = [];
  for (let i = 0; i < islands.length; i++) {
    const ia = islands[i]!;
    for (let j = i + 1; j < islands.length; j++) {
      const ib = islands[j]!;
      let bestDist = Infinity;
      let bestA = ia.anchors[0]!;
      let bestB = ib.anchors[0]!;
      for (const aa of ia.anchors) {
        for (const ab of ib.anchors) {
          const d = Math.hypot(aa.at[0] - ab.at[0], aa.at[1] - ab.at[1]);
          if (
            d < bestDist - 1e-9
            || (Math.abs(d - bestDist) <= 1e-9
              && (cmpAnchor(aa, bestA) < 0 || (cmpAnchor(aa, bestA) === 0 && cmpAnchor(ab, bestB) < 0)))
          ) {
            bestDist = d;
            bestA = aa;
            bestB = ab;
          }
        }
      }
      const flip = cmpAnchor(bestA, bestB) > 0;
      edges.push({
        u: i,
        v: j,
        dist: bestDist,
        from: flip ? bestB : bestA,
        to: flip ? bestA : bestB,
      });
    }
  }

  edges.sort((a, b) => {
    if (Math.abs(a.dist - b.dist) > 1e-9) return a.dist - b.dist;
    return cmpAnchor(a.from, b.from) || cmpAnchor(a.to, b.to);
  });

  const iparent = Array.from({ length: islands.length }, (_, i) => i);
  const ifind = (x: number): number => {
    while (iparent[x] !== x) {
      iparent[x] = iparent[iparent[x]!]!;
      x = iparent[x]!;
    }
    return x;
  };

  const conns: Connection[] = [];
  for (const e of edges) {
    const ru = ifind(e.u);
    const rv = ifind(e.v);
    if (ru === rv) continue;
    iparent[ru] = rv;
    conns.push({
      netId: net.id,
      net: net.name,
      from: [e.from.at[0], e.from.at[1]],
      to: [e.to.at[0], e.to.at[1]],
      ...(e.from.pin ? { fromPin: e.from.pin } : {}),
      ...(e.to.pin ? { toPin: e.to.pin } : {}),
    });
    if (conns.length === islands.length - 1) break;
  }

  return { islands, ratsnest: conns };
}

/** Build full copper connectivity graph, per-net islands, and deterministic ratsnest MSTs. */
export function analyzeConnectivity(
  q: Query,
  opts?: ConnectOptions & { ignoreNetIds?: Set<string> },
): ConnectivityAnalysis {
  const padList = opts?.pads ?? resolvePads(q);
  const items: CopperItem[] = [];
  const byNetItems = new Map<string, CopperItem[]>();
  const addNetItem = (netId: string, item: CopperItem) => {
    const list = byNetItems.get(netId) ?? [];
    list.push(item);
    byNetItems.set(netId, list);
  };

  for (let i = 0; i < padList.length; i++) {
    const pad = padList[i]!;
    const net = resolveNetForPad(q, pad);
    const netKey = net ? net.id : `unconn:${pad.compId}:${pad.pinId}`;
    const item: CopperItem = {
      kind: 'pad',
      objectKey: `pad:${pad.compId}:${pad.pinId}:${i}`,
      netKey,
      ...(net ? { netId: net.id } : {}),
      netName: net?.name ?? 'unconnected',
      label: `pad ${pad.pinLabel}`,
      shape: padToShape(pad),
      pad,
      anchors: [{ at: [pad.at[0], pad.at[1]], pin: pad.pinLabel, key: `pad:${pad.pinLabel}:${i}` }],
    };
    items.push(item);
    if (net) addNetItem(net.id, item);
  }

  const pcb = q.circuit.pcb;
  if (pcb) {
    for (let ti = 0; ti < pcb.tracks.length; ti++) {
      const t = pcb.tracks[ti]!;
      if (opts?.ignoreNetIds?.has(t.net)) continue;
      const net = q.circuit.nets[t.net];
      const netName = net?.name ?? t.net;
      if (t.points.length === 1) {
        const pt = t.points[0]!;
        const item: CopperItem = {
          kind: 'track',
          objectKey: `track:${ti}`,
          netKey: t.net,
          netId: t.net,
          netName,
          label: `track ${netName} (${t.layer})`,
          shape: segmentToShape(pt[0], pt[1], pt[0], pt[1], t.width, t.layer),
          trackIndex: ti,
          anchors: [{ at: [pt[0], pt[1]], key: `trk:${ti}:0:${fmtMm(pt[0])},${fmtMm(pt[1])}` }],
        };
        items.push(item);
        if (net) addNetItem(net.id, item);
        continue;
      }
      for (let si = 0; si < t.points.length - 1; si++) {
        const a = t.points[si]!;
        const b = t.points[si + 1]!;
        const anchors: Anchor[] = [
          { at: [a[0], a[1]], key: `trk:${ti}:${si}:${fmtMm(a[0])},${fmtMm(a[1])}` },
          { at: [b[0], b[1]], key: `trk:${ti}:${si + 1}:${fmtMm(b[0])},${fmtMm(b[1])}` },
        ];
        const item: CopperItem = {
          kind: 'track',
          objectKey: `track:${ti}`,
          netKey: t.net,
          netId: t.net,
          netName,
          label: `track ${netName} (${t.layer})`,
          shape: segmentToShape(a[0], a[1], b[0], b[1], t.width, t.layer),
          trackIndex: ti,
          anchors,
        };
        items.push(item);
        if (net) addNetItem(net.id, item);
      }
    }

    for (let vi = 0; vi < pcb.vias.length; vi++) {
      const v = pcb.vias[vi]!;
      if (opts?.ignoreNetIds?.has(v.net)) continue;
      const net = q.circuit.nets[v.net];
      const netName = net?.name ?? v.net;
      const item: CopperItem = {
        kind: 'via',
        objectKey: `via:${vi}`,
        netKey: v.net,
        netId: v.net,
        netName,
        label: `via ${netName}`,
        shape: viaToShape(v),
        viaIndex: vi,
        anchors: [{ at: [v.at[0], v.at[1]], key: `via:${vi}:${fmtMm(v.at[0])},${fmtMm(v.at[1])}` }],
      };
      items.push(item);
      if (net) addNetItem(net.id, item);
    }
  }

  const byNet = new Map<string, NetConnectivity>();
  const allConns: Connection[] = [];

  for (const net of q.nets()) {
    const netItems = byNetItems.get(net.id) ?? [];
    const { islands, ratsnest: netConns } = computeIslandsAndMst(net, netItems);
    byNet.set(net.id, { net, items: netItems, islands, ratsnest: netConns });
    allConns.push(...netConns);
  }

  return {
    pads: padList,
    items,
    byNet,
    ratsnest: { connections: allConns, count: allConns.length },
  };
}

/** Compute unrouted ratsnest connections across all PCB nets. */
export function ratsnest(q: Query, opts?: ConnectOptions): Ratsnest {
  return analyzeConnectivity(q, opts).ratsnest;
}
