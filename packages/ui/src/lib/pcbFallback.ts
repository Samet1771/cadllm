// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import {
  DEFAULT_PCB_RULES,
  pinKey,
  type Component,
  type PartDef,
  type PcbLayer,
  type PcbTrack,
  type PcbVia,
  type Query,
} from '@cadllm/core';
import {
  componentFootprintName,
  formatPcbPlace,
  isPcbPart,
  pads as realPads,
  parsePcbPlace,
  pcb as realPcb,
  route as realRoute,
  type DrcIssue,
  type PadDef,
  type PadInstance,
  type PcbPlaceOptions,
  type PcbPlaceResult,
  type PcbRenderLayer,
  type PcbRenderOptions,
  type Point,
  type RouteOptions,
  type RouteResult,
} from '@cadllm/pcb';
import { UNIT, el, esc, num, svgDoc } from '@cadllm/views';
import { distToSegment, fmtMm, netNameById, padLabel } from './pcb.ts';

function isNotImplementedError(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}

interface DemoFootprint {
  pads: PadDef[];
  size: [number, number];
}

function demoDipPads(count: number, rowSpanMm: number, pitchMm = 2.54): PadDef[] {
  const half = count / 2;
  const out: PadDef[] = [];
  const y0 = -((half - 1) * pitchMm) / 2;
  for (let i = 0; i < half; i++) {
    out.push({
      id: String(i + 1),
      shape: i === 0 ? 'rect' : 'circle',
      at: [-rowSpanMm / 2, y0 + i * pitchMm],
      size: [1.6, 1.6],
      drill: 0.8,
      layers: 'TH',
    });
  }
  for (let i = 0; i < half; i++) {
    out.push({
      id: String(count - i),
      shape: 'circle',
      at: [rowSpanMm / 2, y0 + i * pitchMm],
      size: [1.6, 1.6],
      drill: 0.8,
      layers: 'TH',
    });
  }
  return out;
}

function demoFootprint(name: string | undefined, part: PartDef): DemoFootprint {
  switch (name) {
    case '0805':
      return {
        pads: [
          { id: '1', shape: 'rect', at: [-0.95, 0], size: [1.0, 1.3], layers: 'F' },
          { id: '2', shape: 'rect', at: [0.95, 0], size: [1.0, 1.3], layers: 'F' },
        ],
        size: [3.6, 1.8],
      };
    case 'THT-axial':
      return {
        pads: [
          { id: '1', shape: 'circle', at: [-5.08, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
          { id: '2', shape: 'circle', at: [5.08, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
        ],
        size: [12.5, 3.0],
      };
    case 'LED_D5.0mm':
    case 'LED_D3.0mm':
      return {
        pads: [
          { id: '1', shape: 'rect', at: [-1.27, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
          { id: '2', shape: 'circle', at: [1.27, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
        ],
        size: [5.6, 5.6],
      };
    case 'Header_1x02_P2.54mm':
    case 'WireLeads':
      return {
        pads: [
          { id: '1', shape: 'rect', at: [0, -1.27], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
          { id: '2', shape: 'circle', at: [0, 1.27], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
        ],
        size: [3.2, 5.4],
      };
    case 'SW_PUSH_6mm':
      return {
        pads: [
          { id: '1', shape: 'circle', at: [-3.25, -2.25], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
          { id: '2', shape: 'circle', at: [3.25, -2.25], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
        ],
        size: [8.0, 6.8],
      };
    case 'DIP-14':
      return { pads: demoDipPads(14, 7.62), size: [10.0, 19.0] };
    case 'DIP-8':
      return { pads: demoDipPads(8, 7.62), size: [10.0, 11.5] };
    case 'SOIC-14':
      return {
        pads: demoDipPads(14, 5.4, 1.27).map(p => ({ ...p, shape: 'rect' as const, size: [1.5, 0.6], drill: undefined, layers: 'F' as const })),
        size: [7.6, 9.6],
      };
    default: {
      const n = part.pins.length;
      if (n <= 2) {
        return {
          pads: part.pins.map((pin, idx) => ({
            id: pin.id,
            shape: idx === 0 ? 'rect' : 'circle',
            at: [idx === 0 ? -2.54 : 2.54, 0],
            size: [1.6, 1.6],
            drill: 0.8,
            layers: 'TH',
          })),
          size: [8.0, 3.6],
        };
      }
      const cols = Math.ceil(n / 2);
      const pads: PadDef[] = part.pins.map((pin, idx) => {
        const side = idx < cols ? -1 : 1;
        const row = idx < cols ? idx : idx - cols;
        return {
          id: pin.id,
          shape: idx === 0 ? 'rect' : 'circle',
          at: [side * 3.81, (row - (cols - 1) / 2) * 2.54],
          size: [1.5, 1.5],
          drill: 0.8,
          layers: 'TH',
        };
      });
      return { pads, size: [10.2, Math.max(6, cols * 2.54 + 2)] };
    }
  }
}

function transformPad(comp: Component, part: PartDef, pad: PadDef, query: Query): PadInstance | undefined {
  const place = parsePcbPlace(comp.place.pcb);
  if (!place) return undefined;

  const lx = place.side === 'bottom' ? -pad.at[0] : pad.at[0];
  const ly = pad.at[1];
  const rad = (place.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wx = place.x + lx * cos - ly * sin;
  const wy = place.y + lx * sin + ly * cos;

  const pk = pinKey(comp.id, pad.id);
  const pinLabel = query.pinLabel(pk);
  const net = query.netOfPin(pk);
  const layers =
    pad.layers === 'TH'
      ? 'TH'
      : place.side === 'bottom'
        ? (pad.layers === 'F' ? 'B' : 'F')
        : pad.layers;

  return {
    ref: comp.ref,
    compId: comp.id,
    pinId: pad.id,
    pinLabel,
    ...(net ? { netId: net.id, net: net.name } : {}),
    shape: pad.shape,
    at: [Math.round(wx * 1e4) / 1e4, Math.round(wy * 1e4) / 1e4],
    size: pad.size,
    rot: place.rot,
    ...(pad.drill !== undefined ? { drill: pad.drill } : {}),
    layers,
    ...(pad.roundRadius !== undefined ? { roundRadius: pad.roundRadius } : {}),
  };
}

function demoPads(query: Query): PadInstance[] {
  const out: PadInstance[] = [];
  for (const comp of query.components()) {
    const part = query.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    if (!parsePcbPlace(comp.place.pcb)) continue;
    const fpName = componentFootprintName(part, comp);
    const fp = demoFootprint(fpName, part);
    for (let i = 0; i < fp.pads.length && i < part.pins.length; i++) {
      const def = { ...fp.pads[i]!, id: part.pins[i]!.id };
      const inst = transformPad(comp, part, def, query);
      if (inst) out.push(inst);
    }
  }
  return out;
}

/**
 * Resolve world-space PadInstances via `@cadllm/pcb` `pads(q)`.
 * In `?demo` mode, falls back to demo footprints while WP1 is not yet implemented.
 */
export function resolvePcbPads(query: Query, isDemo: boolean): PadInstance[] {
  try {
    return realPads(query);
  } catch (err) {
    if (isNotImplementedError(err)) {
      return isDemo ? demoPads(query) : [];
    }
    throw err;
  }
}

function buildDemoRatsnest(query: Query, padList: PadInstance[]): { netName: string; netId: string; from: Point; to: Point }[] {
  const tracks = query.circuit.pcb?.tracks ?? [];
  const vias = query.circuit.pcb?.vias ?? [];
  const out: { netName: string; netId: string; from: Point; to: Point }[] = [];

  for (const net of query.nets()) {
    const netPads = padList.filter(p => p.netId === net.id);
    if (netPads.length < 2) continue;

    // Union-find across pads connected by matching tracks/vias on compatible layers
    const parent = netPads.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const netTracks = tracks.filter(t => t.net === net.id);
    const netVias = vias.filter(v => v.net === net.id);

    // Connect pads touching the same track
    const padTouchesPt = (pad: PadInstance, pt: Point, layer?: PcbLayer): boolean => {
      if (layer && pad.layers !== 'TH' && pad.layers !== layer) return false;
      const r = Math.max(pad.size[0], pad.size[1]) / 2 + 0.15;
      return Math.hypot(pad.at[0] - pt[0], pad.at[1] - pt[1]) <= r;
    };

    // Track-to-track and track-to-via graph
    const nodeCount = netPads.length + netTracks.length + netVias.length;
    const gParent = Array.from({ length: nodeCount }, (_, i) => i);
    const gFind = (i: number): number => {
      while (gParent[i] !== i) {
        gParent[i] = gParent[gParent[i]!]!;
        i = gParent[i]!;
      }
      return i;
    };
    const gUnion = (a: number, b: number) => {
      const ra = gFind(a);
      const rb = gFind(b);
      if (ra !== rb) gParent[rb] = ra;
    };

    for (let ti = 0; ti < netTracks.length; ti++) {
      const t = netTracks[ti]!;
      const tNode = netPads.length + ti;
      for (let pi = 0; pi < netPads.length; pi++) {
        const pad = netPads[pi]!;
        if (pad.layers !== 'TH' && pad.layers !== t.layer) continue;
        for (let s = 0; s + 1 < t.points.length; s++) {
          if (distToSegment(pad.at, t.points[s]!, t.points[s + 1]!) <= Math.max(pad.size[0], pad.size[1]) / 2 + t.width / 2 + 0.1) {
            gUnion(pi, tNode);
          }
        }
      }
      for (let vi = 0; vi < netVias.length; vi++) {
        const v = netVias[vi]!;
        const vNode = netPads.length + netTracks.length + vi;
        for (let s = 0; s + 1 < t.points.length; s++) {
          if (distToSegment(v.at, t.points[s]!, t.points[s + 1]!) <= v.size / 2 + t.width / 2 + 0.1) {
            gUnion(tNode, vNode);
          }
        }
      }
      for (let tj = ti + 1; tj < netTracks.length; tj++) {
        const t2 = netTracks[tj]!;
        if (t.layer !== t2.layer) continue;
        for (const pt of t.points) {
          for (let s = 0; s + 1 < t2.points.length; s++) {
            if (distToSegment(pt, t2.points[s]!, t2.points[s + 1]!) <= (t.width + t2.width) / 2 + 0.05) {
              gUnion(tNode, netPads.length + tj);
            }
          }
        }
      }
    }
    for (let vi = 0; vi < netVias.length; vi++) {
      const v = netVias[vi]!;
      for (let pi = 0; pi < netPads.length; pi++) {
        if (padTouchesPt(netPads[pi]!, v.at)) gUnion(pi, netPads.length + netTracks.length + vi);
      }
    }

    for (let i = 0; i < netPads.length; i++) {
      for (let j = i + 1; j < netPads.length; j++) {
        if (gFind(i) === gFind(j)) union(i, j);
      }
    }

    // Greedy Prim MST between unconnected pad clusters
    const edges: { a: number; b: number; d: number }[] = [];
    for (let i = 0; i < netPads.length; i++) {
      for (let j = i + 1; j < netPads.length; j++) {
        if (find(i) !== find(j)) {
          edges.push({
            a: i,
            b: j,
            d: Math.hypot(netPads[i]!.at[0] - netPads[j]!.at[0], netPads[i]!.at[1] - netPads[j]!.at[1]),
          });
        }
      }
    }
    edges.sort((x, y) => x.d - y.d);
    for (const e of edges) {
      if (find(e.a) !== find(e.b)) {
        union(e.a, e.b);
        out.push({ netName: net.name, netId: net.id, from: netPads[e.a]!.at, to: netPads[e.b]!.at });
      }
    }
  }

  return out;
}

function renderDemoPcbSvg(query: Query, opts: PcbRenderOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const showLabels = opts.labels ?? true;
  const visible = new Set<PcbRenderLayer>(
    opts.layers ?? ['F', 'B', 'silk', 'outline', 'ratsnest', 'courtyard'],
  );

  const hlRefs = new Set<string>();
  const hlNets = new Set<string>();
  for (const h of opts.highlight ?? []) {
    if (h.toLowerCase().startsWith('net:')) hlNets.add(h.slice(4).toUpperCase());
    else hlRefs.add(h.toUpperCase());
  }

  const outline = query.circuit.pcb?.board?.outline ?? [[0, 0], [40, 0], [40, 30], [0, 30]];
  const padList = demoPads(query);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (const p of padList) {
    minX = Math.min(minX, p.at[0] - 4);
    minY = Math.min(minY, p.at[1] - 4);
    maxX = Math.max(maxX, p.at[0] + 4);
    maxY = Math.max(maxY, p.at[1] + 4);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 40;
    maxY = 30;
  }

  const margin = 4;
  const box = {
    x: (minX - margin) * UNIT,
    y: (minY - margin) * UNIT,
    w: Math.max(100, (maxX - minX + margin * 2) * UNIT),
    h: Math.max(80, (maxY - minY + margin * 2) * UNIT),
  };

  const isDark = theme === 'dark';
  const style = [
    `.pcb-bg { fill: ${isDark ? '#11151b' : '#f4f6f8'}; }`,
    `.pcb-board { fill: ${isDark ? '#16271d' : '#e7f0ea'}; stroke: ${isDark ? '#e5c07b' : '#b45309'}; stroke-width: 1.5; }`,
    `.pcb-track-F { fill: none; stroke: #ef4444; stroke-linecap: round; stroke-linejoin: round; opacity: 0.9; }`,
    `.pcb-track-B { fill: none; stroke: #3b82f6; stroke-linecap: round; stroke-linejoin: round; opacity: 0.85; }`,
    `.pcb-pad-F { fill: #ef4444; }`,
    `.pcb-pad-B { fill: #3b82f6; }`,
    `.pcb-pad-TH { fill: #d97706; }`,
    `.pcb-hole { fill: ${isDark ? '#11151b' : '#f4f6f8'}; }`,
    `.pcb-via { fill: #eab308; stroke: ${isDark ? '#11151b' : '#374151'}; stroke-width: 0.6; }`,
    `.pcb-silk { fill: none; stroke: ${isDark ? '#e5e7eb' : '#1f2937'}; stroke-width: 1.2; }`,
    `.pcb-silk-text { fill: ${isDark ? '#e5e7eb' : '#1f2937'}; font-family: ui-monospace, monospace; font-size: 9px; font-weight: 600; }`,
    `.pcb-cy { fill: none; stroke: #a855f7; stroke-width: 0.8; stroke-dasharray: 3 2; }`,
    `.pcb-rats { stroke: ${isDark ? '#facc15' : '#ca8a04'}; stroke-width: 1.1; stroke-dasharray: 4 3; opacity: 0.85; }`,
    `.hl { filter: drop-shadow(0 0 4px #a855f7); }`,
  ].join('\n');

  const body: string[] = [
    el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, class: 'pcb-bg' }),
  ];

  if (visible.has('outline')) {
    const pts = outline.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' ');
    body.push(el('polygon', { points: pts, class: 'pcb-board' }));
  }

  const tracks = query.circuit.pcb?.tracks ?? [];
  const vias = query.circuit.pcb?.vias ?? [];

  // Group tracks & vias by net name for <g data-net="...">
  const byNet = new Map<string, { tracks: PcbTrack[]; vias: PcbVia[] }>();
  for (const t of tracks) {
    if (!visible.has(t.layer)) continue;
    const name = netNameById(query, t.net);
    const entry = byNet.get(name) ?? { tracks: [], vias: [] };
    entry.tracks.push(t);
    byNet.set(name, entry);
  }
  for (const v of vias) {
    if (!visible.has('F') && !visible.has('B')) continue;
    const name = netNameById(query, v.net);
    const entry = byNet.get(name) ?? { tracks: [], vias: [] };
    entry.vias.push(v);
    byNet.set(name, entry);
  }

  for (const [netName, group] of byNet) {
    const netEls: string[] = [];
    for (const t of group.tracks) {
      const pts = t.points.map(([x, y]) => `${num(x * UNIT)},${num(y * UNIT)}`).join(' ');
      netEls.push(el('polyline', {
        points: pts,
        class: `pcb-track-${t.layer}`,
        'stroke-width': t.width * UNIT,
      }));
    }
    for (const v of group.vias) {
      netEls.push(el('circle', {
        cx: v.at[0] * UNIT,
        cy: v.at[1] * UNIT,
        r: (v.size / 2) * UNIT,
        class: 'pcb-via',
      }));
      netEls.push(el('circle', {
        cx: v.at[0] * UNIT,
        cy: v.at[1] * UNIT,
        r: (v.drill / 2) * UNIT,
        class: 'pcb-hole',
      }));
    }
    const isHl = hlNets.has(netName.toUpperCase());
    body.push(el('g', { 'data-net': netName, ...(isHl ? { class: 'hl' } : {}) }, netEls));
  }

  // Components
  for (const comp of query.components()) {
    const part = query.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const place = parsePcbPlace(comp.place.pcb);
    if (!place) continue;
    const fpName = componentFootprintName(part, comp);
    const fp = demoFootprint(fpName, part);
    const compPads = padList.filter(p => p.compId === comp.id);
    const compEls: string[] = [];

    const [cw, ch] = fp.size;
    const transform = `translate(${num(place.x * UNIT)} ${num(place.y * UNIT)}) rotate(${num(place.rot)})`;

    if (visible.has('courtyard')) {
      compEls.push(el('rect', {
        x: (-cw / 2) * UNIT,
        y: (-ch / 2) * UNIT,
        width: cw * UNIT,
        height: ch * UNIT,
        transform,
        class: 'pcb-cy',
      }));
    }

    if (visible.has('silk')) {
      compEls.push(el('rect', {
        x: (-cw / 2 + 0.25) * UNIT,
        y: (-ch / 2 + 0.25) * UNIT,
        width: Math.max(4, (cw - 0.5) * UNIT),
        height: Math.max(4, (ch - 0.5) * UNIT),
        rx: 2,
        transform,
        class: 'pcb-silk',
      }));
      if (showLabels) {
        compEls.push(el('text', {
          x: place.x * UNIT,
          y: (place.y - ch / 2 - 0.7) * UNIT,
          'text-anchor': 'middle',
          class: 'pcb-silk-text',
        }, esc(comp.ref)));
      }
    }

    for (const p of compPads) {
      if (p.layers === 'F' && !visible.has('F')) continue;
      if (p.layers === 'B' && !visible.has('B')) continue;
      if (p.layers === 'TH' && !visible.has('F') && !visible.has('B')) continue;

      const label = padLabel(p);
      const pw = p.size[0] * UNIT;
      const ph = p.size[1] * UNIT;
      const cx = p.at[0] * UNIT;
      const cy = p.at[1] * UNIT;
      const padClass = `pcb-pad-${p.layers}`;
      const padTransform = p.rot ? `rotate(${num(p.rot)} ${num(cx)} ${num(cy)})` : undefined;

      if (p.shape === 'circle') {
        compEls.push(el('circle', { cx, cy, r: pw / 2, class: padClass, 'data-pin': label }));
      } else {
        compEls.push(el('rect', {
          x: cx - pw / 2,
          y: cy - ph / 2,
          width: pw,
          height: ph,
          rx: p.shape === 'roundrect' ? Math.min(pw, ph) * 0.25 : undefined,
          transform: padTransform,
          class: padClass,
          'data-pin': label,
        }));
      }
      if (p.drill) {
        compEls.push(el('circle', {
          cx,
          cy,
          r: (p.drill / 2) * UNIT,
          class: 'pcb-hole',
          'pointer-events': 'none',
        }));
      }
    }

    const isHl = hlRefs.has(comp.ref.toUpperCase());
    body.push(el('g', { 'data-ref': comp.ref, ...(isHl ? { class: 'hl' } : {}) }, compEls));
  }

  if (visible.has('ratsnest')) {
    const rats = buildDemoRatsnest(query, padList);
    for (const r of rats) {
      body.push(el('line', {
        x1: r.from[0] * UNIT,
        y1: r.from[1] * UNIT,
        x2: r.to[0] * UNIT,
        y2: r.to[1] * UNIT,
        class: 'pcb-rats',
        'data-rats-net': r.netName,
      }));
    }
  }

  return svgDoc('pcb', box, body, style);
}

/**
 * Render the PCB view using `@cadllm/pcb`'s `pcb.render`.
 * In `?demo` mode only, falls back to a local demo SVG renderer while WP1 is not yet implemented.
 */
export function renderPcbWithFallback(
  query: Query,
  opts: PcbRenderOptions,
  isDemo: boolean,
): { svg: string; isFallback: boolean } {
  try {
    return { svg: realPcb.render(query, opts), isFallback: false };
  } catch (err) {
    if (isDemo && isNotImplementedError(err)) {
      return { svg: renderDemoPcbSvg(query, opts), isFallback: true };
    }
    throw err;
  }
}

function demoDrcChecks(query: Query): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const rules = { ...DEFAULT_PCB_RULES, ...query.circuit.pcb?.rules };
  const padList = demoPads(query);

  for (const comp of query.components()) {
    const part = query.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    if (!comp.place.pcb) {
      issues.push({
        level: 'warn',
        code: 'unplaced',
        message: `${comp.ref} has no @pcb placement`,
        at: [comp.ref],
      });
    } else if (!parsePcbPlace(comp.place.pcb)) {
      issues.push({
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref} invalid @pcb placement "${comp.place.pcb}"`,
        at: [comp.ref],
      });
    }
  }

  const outline = query.circuit.pcb?.board?.outline;
  if (outline && outline.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outline) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    for (const pad of padList) {
      if (pad.at[0] < minX || pad.at[0] > maxX || pad.at[1] < minY || pad.at[1] > maxY) {
        issues.push({
          level: 'error',
          code: 'off_board',
          message: `Pad ${padLabel(pad)} is outside board outline`,
          at: [padLabel(pad), pad.ref],
        });
      }
    }
  }

  for (const t of query.circuit.pcb?.tracks ?? []) {
    if (t.width < rules.track - 1e-6) {
      const netName = netNameById(query, t.net);
      issues.push({
        level: 'error',
        code: 'track_width',
        message: `Track on ${netName} (${fmtMm(t.width)} mm) < rule ${fmtMm(rules.track)} mm`,
        at: [netName],
      });
    }
  }

  const rats = buildDemoRatsnest(query, padList);
  const seenUnrouted = new Set<string>();
  for (const r of rats) {
    if (seenUnrouted.has(r.netId)) continue;
    seenUnrouted.add(r.netId);
    issues.push({
      level: 'warn',
      code: 'unrouted',
      message: `Net ${r.netName} has unrouted connections`,
      at: [r.netName],
    });
  }

  return issues;
}

/**
 * Run structured PCB DRC via `pcb.check(q)`.
 * Returns `pending: true` when WP2 is not implemented in live mode, or demo checks in `?demo` mode.
 */
export function checkPcbDrc(
  query: Query,
  isDemo: boolean,
): { issues: DrcIssue[]; pending: boolean } {
  try {
    return { issues: realPcb.check(query), pending: false };
  } catch (err) {
    if (isNotImplementedError(err)) {
      return isDemo ? { issues: demoDrcChecks(query), pending: false } : { issues: [], pending: true };
    }
    throw err;
  }
}

/** Demo-only PCB auto-place fallback when WP1 is not implemented yet. */
export function autoPlacePcbWithFallback(query: Query, opts?: PcbPlaceOptions): PcbPlaceResult {
  try {
    return realPcb.autoPlace(query, opts);
  } catch (err) {
    if (!isNotImplementedError(err)) throw err;
    const place: Record<string, string> = {};
    let x = 6;
    let y = 7;
    for (const comp of query.components()) {
      const part = query.parts.get(comp.part);
      if (!part || !isPcbPart(part)) continue;
      if (!opts?.all && comp.place.pcb) continue;
      place[comp.ref] = formatPcbPlace({ x, y, rot: 0, side: 'top' });
      x += 10;
      if (x > 26) {
        x = 6;
        y += 8;
      }
    }
    return { place, notes: ['demo auto-place fallback'] };
  }
}

/** Demo-only PCB autoroute fallback when WP2 is not implemented yet. */
export function routePcbWithFallback(query: Query, opts?: RouteOptions): RouteResult {
  try {
    return realRoute(query, opts);
  } catch (err) {
    if (!isNotImplementedError(err)) throw err;
    const padList = demoPads(query);
    const rats = buildDemoRatsnest(query, padList);
    const width = query.circuit.pcb?.rules?.track ?? DEFAULT_PCB_RULES.track;
    const filterNets = opts?.nets ? new Set(opts.nets.map(n => n.toUpperCase())) : undefined;
    const tracks: PcbTrack[] = [];
    for (const r of rats) {
      if (filterNets && !filterNets.has(r.netName.toUpperCase())) continue;
      const midX = r.to[0];
      const midY = r.from[1];
      const pts: Point[] =
        Math.abs(r.from[0] - r.to[0]) < 1e-4 || Math.abs(r.from[1] - r.to[1]) < 1e-4
          ? [r.from, r.to]
          : [r.from, [midX, midY], r.to];
      tracks.push({ net: r.netId, layer: 'F', width, points: pts });
    }
    return { tracks, vias: [], unrouted: [], notes: ['demo Manhattan route fallback'] };
  }
}
