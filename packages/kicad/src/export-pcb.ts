// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, pinKey, type Component, type Query } from '@cadllm/core';
import {
  componentFootprintName,
  footprint as pcbFootprint,
  isPcbPart,
  pads as pcbPads,
  parsePcbPlace,
  type Footprint,
  type PadDef,
  type PadInstance,
  type PcbPlace,
} from '@cadllm/pcb';
import { importKicadMod, roundMm } from './import-mod.ts';
import { num, printSexpr, str, sym, type Sexpr } from './sexpr.ts';

export interface ExportKicadPcbOptions {
  /** Custom footprint resolver (defaults to `@cadllm/pcb` `footprint`). */
  footprints?: Record<string, Footprint> | ((name: string) => Footprint | undefined);
  /** Custom world pad resolver (defaults to `@cadllm/pcb` `pads`). */
  pads?: PadInstance[] | ((q: Query) => PadInstance[]);
}

/** Derive a deterministic RFC 4122 v4-formatted UUID from a key string with no randomness. */
export function deterministicUuid(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xdeadbeef;
  let h4 = 0x9e3779b9;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35);
    h4 = Math.imul(h4 ^ c, 0x27d4eb2f);
  }
  const mix = (x: number): number => {
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const a = mix(h1 ^ h2).toString(16).padStart(8, '0');
  const b = mix(h2 ^ h3).toString(16).padStart(8, '0');
  const c = mix(h3 ^ h4).toString(16).padStart(8, '0');
  const d = mix(h4 ^ h1).toString(16).padStart(8, '0');
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4, 8)}${d}`;
}

function wrapWp1Error(err: unknown): never {
  if (err instanceof Error && /not implemented yet \(M3 WP1\)/.test(err.message)) {
    throw new Error(`${err.message} — required by KiCad .kicad_pcb exporter: not implemented yet (M3 WP5)`);
  }
  throw err;
}

function resolveFootprintFromOpts(
  name: string,
  opts?: ExportKicadPcbOptions,
): Footprint | undefined {
  if (name.trim().startsWith('(')) return importKicadMod(name);
  if (!opts?.footprints) return undefined;
  if (typeof opts.footprints === 'function') return opts.footprints(name);
  return opts.footprints[name];
}

function synthesizeFootprintFromPads(name: string, compPads: PadInstance[], place: PcbPlace): Footprint {
  const rad = (-place.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const padDefs: PadDef[] = compPads.map(p => {
    const dx = p.at[0] - place.x;
    const dy = p.at[1] - place.y;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const lx = place.side === 'bottom' ? -rx : rx;
    const ly = ry;
    const layers =
      p.layers === 'TH'
        ? 'TH'
        : place.side === 'bottom'
          ? p.layers === 'B'
            ? 'F'
            : 'B'
          : p.layers;
    return {
      id: p.pinId,
      shape: p.shape,
      at: [roundMm(lx), roundMm(ly)],
      size: [roundMm(p.size[0]), roundMm(p.size[1])],
      ...(p.drill !== undefined ? { drill: roundMm(p.drill) } : {}),
      layers,
      ...(p.roundRadius !== undefined ? { roundRadius: roundMm(p.roundRadius) } : {}),
    };
  });
  return {
    name,
    pads: padDefs,
    silk: [],
    courtyard: [0, 0],
    origin: [0, 0],
  };
}

function resolveAllPads(q: Query, opts?: ExportKicadPcbOptions): PadInstance[] {
  if (opts?.pads) {
    return typeof opts.pads === 'function' ? opts.pads(q) : opts.pads;
  }
  try {
    return pcbPads(q);
  } catch (err) {
    if (opts?.footprints) return [];
    wrapWp1Error(err);
  }
}

function resolveFootprint(
  fpName: string,
  compPads: PadInstance[],
  place: PcbPlace,
  opts?: ExportKicadPcbOptions,
): Footprint {
  const custom = resolveFootprintFromOpts(fpName, opts);
  if (custom) return custom;
  try {
    return pcbFootprint(fpName);
  } catch (err) {
    if (opts?.pads && compPads.length > 0) {
      return synthesizeFootprintFromPads(fpName, compPads, place);
    }
    wrapWp1Error(err);
  }
}

function componentDisplayValue(q: Query, comp: Component): string {
  const part = q.part(comp);
  if (part.valueProp && comp.props[part.valueProp] !== undefined) {
    return comp.props[part.valueProp]!;
  }
  return comp.part;
}

function buildSilkNodes(fp: Footprint, compRef: string, side: 'top' | 'bottom'): Sexpr[] {
  const out: Sexpr[] = [];
  const silkLayer = side === 'bottom' ? 'B.SilkS' : 'F.SilkS';

  for (let i = 0; i < fp.silk.length; i++) {
    const s = fp.silk[i]!;
    const w = roundMm(s.width ?? 0.12);
    const uuid = deterministicUuid(`fp:${compRef}:silk:${i}`);
    if (s.kind === 'line') {
      out.push([
        sym('fp_line'),
        [sym('start'), num(roundMm(s.from[0])), num(roundMm(s.from[1]))],
        [sym('end'), num(roundMm(s.to[0])), num(roundMm(s.to[1]))],
        [sym('stroke'), [sym('width'), num(w)], [sym('type'), sym('solid')]],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(uuid)],
      ]);
    } else if (s.kind === 'rect') {
      out.push([
        sym('fp_rect'),
        [sym('start'), num(roundMm(s.at[0])), num(roundMm(s.at[1]))],
        [sym('end'), num(roundMm(s.at[0] + s.size[0])), num(roundMm(s.at[1] + s.size[1]))],
        [sym('stroke'), [sym('width'), num(w)], [sym('type'), sym('solid')]],
        [sym('fill'), sym('none')],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(uuid)],
      ]);
    } else if (s.kind === 'circle') {
      out.push([
        sym('fp_circle'),
        [sym('center'), num(roundMm(s.at[0])), num(roundMm(s.at[1]))],
        [sym('end'), num(roundMm(s.at[0] + s.r)), num(roundMm(s.at[1]))],
        [sym('stroke'), [sym('width'), num(w)], [sym('type'), sym('solid')]],
        [sym('fill'), sym('none')],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(uuid)],
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
      out.push([
        sym('fp_arc'),
        [sym('start'), num(sx), num(sy)],
        [sym('mid'), num(mx), num(my)],
        [sym('end'), num(ex), num(ey)],
        [sym('stroke'), [sym('width'), num(w)], [sym('type'), sym('solid')]],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(uuid)],
      ]);
    } else if (s.kind === 'poly') {
      out.push([
        sym('fp_poly'),
        [sym('pts'), ...s.points.map(([px, py]) => [sym('xy'), num(roundMm(px)), num(roundMm(py))])],
        [sym('stroke'), [sym('width'), num(w)], [sym('type'), sym('solid')]],
        [sym('fill'), sym('none')],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(uuid)],
      ]);
    }
  }

  if (fp.courtyard[0] > 0 || fp.courtyard[1] > 0) {
    const crtLayer = side === 'bottom' ? 'B.CrtYd' : 'F.CrtYd';
    const b = fp.courtyardBounds ?? {
      minX: roundMm(-fp.courtyard[0] / 2),
      minY: roundMm(-fp.courtyard[1] / 2),
      maxX: roundMm(fp.courtyard[0] / 2),
      maxY: roundMm(fp.courtyard[1] / 2),
    };
    out.push([
      sym('fp_rect'),
      [sym('start'), num(roundMm(b.minX)), num(roundMm(b.minY))],
      [sym('end'), num(roundMm(b.maxX)), num(roundMm(b.maxY))],
      [sym('stroke'), [sym('width'), num(0.05)], [sym('type'), sym('solid')]],
      [sym('fill'), sym('none')],
      [sym('layer'), str(crtLayer)],
      [sym('uuid'), str(deterministicUuid(`fp:${compRef}:crtyd`))],
    ]);
  }

  return out;
}

/** Export a circuit's PCB layout to KiCad 9 `.kicad_pcb` S-expression format. */
export function exportKicadPcb(q: Query, opts?: ExportKicadPcbOptions): string {
  const allPads = resolveAllPads(q, opts);

  const placed: {
    comp: Component;
    place: PcbPlace;
    fpName: string;
    fp: Footprint;
    compPads: Map<string, PadInstance>;
  }[] = [];

  for (const comp of q.components()) {
    const part = q.part(comp);
    if (!isPcbPart(part)) continue;
    const place = parsePcbPlace(comp.place.pcb);
    if (!place) continue;
    const fpName = componentFootprintName(part, comp);
    if (!fpName) continue;
    const forComp = allPads.filter(p => p.ref === comp.ref || p.compId === comp.id);
    const fp = resolveFootprint(fpName, forComp, place, opts);
    const padMap = new Map<string, PadInstance>();
    for (const p of forComp) padMap.set(p.pinId, p);
    placed.push({ comp, place, fpName, fp, compPads: padMap });
  }

  // Collect all net names in deterministic natural order; net 0 is always "".
  const netNamesSet = new Set<string>();
  const netNameById = new Map<string, string>();
  for (const net of q.nets()) {
    netNamesSet.add(net.name);
    netNameById.set(net.id, net.name);
  }
  for (const p of allPads) {
    if (p.net) netNamesSet.add(p.net);
    else if (p.netId && netNameById.has(p.netId)) netNamesSet.add(netNameById.get(p.netId)!);
  }
  const pcb = q.circuit.pcb;
  if (pcb) {
    for (const t of pcb.tracks) {
      const name = netNameById.get(t.net) ?? (q.net(t.net)?.name ?? t.net);
      if (name) netNamesSet.add(name);
    }
    for (const v of pcb.vias) {
      const name = netNameById.get(v.net) ?? (q.net(v.net)?.name ?? v.net);
      if (name) netNamesSet.add(name);
    }
  }

  const sortedNetNames = [...netNamesSet].sort(naturalCompare);
  const netNumByName = new Map<string, number>([['', 0]]);
  const netNumById = new Map<string, number>();
  for (let i = 0; i < sortedNetNames.length; i++) {
    const name = sortedNetNames[i]!;
    netNumByName.set(name, i + 1);
  }
  for (const [id, name] of netNameById) {
    const n = netNumByName.get(name);
    if (n !== undefined) netNumById.set(id, n);
  }

  const resolveNetInfo = (idOrName: string | undefined): { num: number; name: string } => {
    if (!idOrName) return { num: 0, name: '' };
    const byIdName = netNameById.get(idOrName);
    if (byIdName !== undefined) {
      return { num: netNumByName.get(byIdName) ?? 0, name: byIdName };
    }
    const byNameNum = netNumByName.get(idOrName);
    if (byNameNum !== undefined) {
      return { num: byNameNum, name: idOrName };
    }
    const qNet = q.net(idOrName);
    if (qNet) {
      return { num: netNumByName.get(qNet.name) ?? 0, name: qNet.name };
    }
    return { num: 0, name: '' };
  };

  const root: Sexpr[] = [
    sym('kicad_pcb'),
    [sym('version'), num(20241229)],
    [sym('generator'), str('cadllm')],
    [sym('generator_version'), str('0.0.0')],
    [sym('general'), [sym('thickness'), num(1.6)], [sym('legacy_teardrops'), sym('no')]],
    [sym('paper'), str('A4')],
    [
      sym('layers'),
      [num(0), str('F.Cu'), sym('signal')],
      [num(31), str('B.Cu'), sym('signal')],
      [num(32), str('B.Adhes'), sym('user'), str('B.Adhesive')],
      [num(33), str('F.Adhes'), sym('user'), str('F.Adhesive')],
      [num(34), str('B.Paste'), sym('user')],
      [num(35), str('F.Paste'), sym('user')],
      [num(36), str('B.SilkS'), sym('user'), str('B.Silkscreen')],
      [num(37), str('F.SilkS'), sym('user'), str('F.Silkscreen')],
      [num(38), str('B.Mask'), sym('user')],
      [num(39), str('F.Mask'), sym('user')],
      [num(44), str('Edge.Cuts'), sym('user')],
      [num(46), str('B.CrtYd'), sym('user'), str('B.Courtyard')],
      [num(47), str('F.CrtYd'), sym('user'), str('F.Courtyard')],
      [num(48), str('B.Fab'), sym('user')],
      [num(49), str('F.Fab'), sym('user')],
    ],
    [sym('setup'), [sym('pad_to_mask_clearance'), num(0)]],
    [sym('net'), num(0), str('')],
  ];

  for (let i = 0; i < sortedNetNames.length; i++) {
    root.push([sym('net'), num(i + 1), str(sortedNetNames[i]!)]);
  }

  // Board outline on Edge.Cuts
  const outline = pcb?.board?.outline;
  if (outline && outline.length >= 3) {
    const first = outline[0]!;
    const last = outline[outline.length - 1]!;
    const alreadyClosed =
      outline.length > 3 && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
    const edgeCount = alreadyClosed ? outline.length - 1 : outline.length;
    for (let i = 0; i < edgeCount; i++) {
      const p0 = outline[i]!;
      const p1 = outline[(i + 1) % outline.length]!;
      root.push([
        sym('gr_line'),
        [sym('start'), num(roundMm(p0[0])), num(roundMm(p0[1]))],
        [sym('end'), num(roundMm(p1[0])), num(roundMm(p1[1]))],
        [sym('stroke'), [sym('width'), num(0.1)], [sym('type'), sym('solid')]],
        [sym('layer'), str('Edge.Cuts')],
        [sym('uuid'), str(deterministicUuid(`edge:${i}:${p0[0]},${p0[1]}-${p1[0]},${p1[1]}`))],
      ]);
    }
  }

  // Placed footprints
  for (const { comp, place, fp, compPads } of placed) {
    const cuLayer = place.side === 'bottom' ? 'B.Cu' : 'F.Cu';
    const silkLayer = place.side === 'bottom' ? 'B.SilkS' : 'F.SilkS';
    const fabLayer = place.side === 'bottom' ? 'B.Fab' : 'F.Fab';
    const atExpr: Sexpr[] =
      place.rot !== 0
        ? [sym('at'), num(roundMm(place.x)), num(roundMm(place.y)), num(roundMm(place.rot))]
        : [sym('at'), num(roundMm(place.x)), num(roundMm(place.y))];

    const fpNode: Sexpr[] = [
      sym('footprint'),
      str(fp.name),
      [sym('layer'), str(cuLayer)],
      [sym('uuid'), str(deterministicUuid(`fp:${comp.ref}`))],
      atExpr,
      [
        sym('property'),
        str('Reference'),
        str(comp.ref),
        [sym('at'), num(0), num(-2), num(0)],
        [sym('layer'), str(silkLayer)],
        [sym('uuid'), str(deterministicUuid(`fp:${comp.ref}:prop:ref`))],
        [sym('effects'), [sym('font'), [sym('size'), num(1), num(1)], [sym('thickness'), num(0.15)]]],
      ],
      [
        sym('property'),
        str('Value'),
        str(componentDisplayValue(q, comp)),
        [sym('at'), num(0), num(2), num(0)],
        [sym('layer'), str(fabLayer)],
        [sym('uuid'), str(deterministicUuid(`fp:${comp.ref}:prop:val`))],
        [sym('effects'), [sym('font'), [sym('size'), num(1), num(1)], [sym('thickness'), num(0.15)]]],
      ],
      ...buildSilkNodes(fp, comp.ref, place.side),
    ];

    for (const pad of fp.pads) {
      const padInst = compPads.get(pad.id);
      const qNet = q.netOfPin(pinKey(comp.id, pad.id));
      const netInfo = resolveNetInfo(padInst?.net ?? padInst?.netId ?? qNet?.id ?? qNet?.name);

      const padType = pad.layers === 'TH' ? 'thru_hole' : 'smd';
      let padLayers: string[];
      if (pad.layers === 'TH') {
        padLayers = ['*.Cu', '*.Mask'];
      } else {
        const onBack = (pad.layers === 'F' && place.side === 'bottom') || (pad.layers === 'B' && place.side !== 'bottom');
        padLayers = onBack ? ['B.Cu', 'B.Paste', 'B.Mask'] : ['F.Cu', 'F.Paste', 'F.Mask'];
      }

      const padNode: Sexpr[] = [
        sym('pad'),
        str(pad.id),
        sym(padType),
        sym(pad.shape),
        [sym('at'), num(roundMm(pad.at[0])), num(roundMm(pad.at[1]))],
        [sym('size'), num(roundMm(pad.size[0])), num(roundMm(pad.size[1]))],
      ];
      if (pad.layers === 'TH' || pad.drill !== undefined) {
        padNode.push([sym('drill'), num(roundMm(pad.drill ?? 0.8))]);
      }
      padNode.push([sym('layers'), ...padLayers.map(str)]);
      if (pad.shape === 'roundrect') {
        padNode.push([sym('roundrect_rratio'), num(roundMm(pad.roundRadius ?? 0.25))]);
      }
      padNode.push([sym('net'), num(netInfo.num), str(netInfo.name)]);
      padNode.push([sym('uuid'), str(deterministicUuid(`fp:${comp.ref}:pad:${pad.id}`))]);
      fpNode.push(padNode);
    }

    root.push(fpNode);
  }

  // Tracks -> segment per consecutive pair of points
  if (pcb) {
    for (let tIdx = 0; tIdx < pcb.tracks.length; tIdx++) {
      const track = pcb.tracks[tIdx]!;
      const netInfo = resolveNetInfo(track.net);
      const layerName = track.layer === 'B' ? 'B.Cu' : 'F.Cu';
      const width = roundMm(track.width);
      for (let sIdx = 0; sIdx < track.points.length - 1; sIdx++) {
        const p0 = track.points[sIdx]!;
        const p1 = track.points[sIdx + 1]!;
        root.push([
          sym('segment'),
          [sym('start'), num(roundMm(p0[0])), num(roundMm(p0[1]))],
          [sym('end'), num(roundMm(p1[0])), num(roundMm(p1[1]))],
          [sym('width'), num(width)],
          [sym('layer'), str(layerName)],
          [sym('net'), num(netInfo.num)],
          [sym('uuid'), str(deterministicUuid(`seg:${tIdx}:${sIdx}:${p0[0]},${p0[1]}-${p1[0]},${p1[1]}`))],
        ]);
      }
    }

    // Vias
    for (let vIdx = 0; vIdx < pcb.vias.length; vIdx++) {
      const via = pcb.vias[vIdx]!;
      const netInfo = resolveNetInfo(via.net);
      root.push([
        sym('via'),
        [sym('at'), num(roundMm(via.at[0])), num(roundMm(via.at[1]))],
        [sym('size'), num(roundMm(via.size))],
        [sym('drill'), num(roundMm(via.drill))],
        [sym('layers'), str('F.Cu'), str('B.Cu')],
        [sym('net'), num(netInfo.num)],
        [sym('uuid'), str(deterministicUuid(`via:${vIdx}:${via.at[0]},${via.at[1]}`))],
      ]);
    }
  }

  return printSexpr(root, { pretty: true });
}
