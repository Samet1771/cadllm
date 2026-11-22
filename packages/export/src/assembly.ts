// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Component, type PartDef, type Query } from '@cadllm/core';
import { componentFootprintName, isPcbPart, parsePcbPlace } from '@cadllm/pcb';

const fmtMm = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};

function csvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function componentValue(part: PartDef, comp: Component): string {
  const vp = part.valueProp;
  if (vp && vp !== 'state') {
    const v = comp.props[vp] ?? part.props?.[vp]?.default;
    if (v !== undefined && v !== '') return v;
  }
  return part.id;
}

/** Generate a deterministic Bill of Materials CSV grouped by value + footprint. */
export function bom(q: Query): string {
  const groups = new Map<string, { refs: string[]; value: string; footprint: string }>();

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const fp = componentFootprintName(part, comp) ?? '';
    const value = componentValue(part, comp);
    const key = `${value}\0${fp}`;
    let group = groups.get(key);
    if (!group) {
      group = { refs: [], value, footprint: fp };
      groups.set(key, group);
    }
    group.refs.push(comp.ref);
  }

  for (const g of groups.values()) {
    g.refs.sort(naturalCompare);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => naturalCompare(a.refs[0] ?? '', b.refs[0] ?? '')
      || naturalCompare(a.value, b.value)
      || naturalCompare(a.footprint, b.footprint),
  );

  const lines = ['ref,value,footprint,qty'];
  for (const g of ordered) {
    lines.push([
      csvCell(g.refs.join(',')),
      csvCell(g.value),
      csvCell(g.footprint),
      String(g.refs.length),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Generate a deterministic pick-and-place (CPL) CSV (`ref,value,footprint,x,y,rotation,side`). */
export function pickAndPlace(q: Query): string {
  const lines = ['ref,value,footprint,x,y,rotation,side'];

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part || !isPcbPart(part)) continue;
    const place = parsePcbPlace(comp.place.pcb);
    if (!place) continue;
    const fp = componentFootprintName(part, comp) ?? '';
    const value = componentValue(part, comp);
    lines.push([
      csvCell(comp.ref),
      csvCell(value),
      csvCell(fp),
      fmtMm(place.x),
      fmtMm(place.y),
      fmtMm(place.rot),
      place.side,
    ].join(','));
  }

  return `${lines.join('\n')}\n`;
}
