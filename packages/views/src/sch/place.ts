// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Pt } from '../types.ts';
import type { Dir, GridBox, SchPlace } from './types.ts';

const INT_RE = /^-?\d+$/;

/** Parse `x,y[,rot][,m]`. Returns undefined if invalid. */
export function parseSchPlace(raw: string): SchPlace | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const parts = s.split(',');
  if (parts.length < 2 || parts.length > 4) return undefined;
  const xs = parts[0]!.trim();
  const ys = parts[1]!.trim();
  if (!INT_RE.test(xs) || !INT_RE.test(ys)) return undefined;
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;

  let rot: 0 | 90 | 180 | 270 = 0;
  let mirror = false;

  if (parts.length >= 3) {
    const p2 = parts[2]!.trim();
    if (p2 === 'm') {
      if (parts.length === 4) return undefined;
      mirror = true;
    } else if (p2 === '0' || p2 === '90' || p2 === '180' || p2 === '270') {
      rot = Number(p2) as 0 | 90 | 180 | 270;
    } else {
      return undefined;
    }
  }

  if (parts.length === 4) {
    const p3 = parts[3]!.trim();
    if (p3 !== 'm') return undefined;
    mirror = true;
  }

  return { x, y, rot, mirror };
}

export function formatSchPlace(p: SchPlace): string {
  const base = `${p.x},${p.y}`;
  if (p.mirror) return `${base},${p.rot},m`;
  if (p.rot !== 0) return `${base},${p.rot}`;
  return base;
}

/**
 * Transform a local point (mirror across X=0 first, then clockwise rotation, then translate).
 * Matches SVG `translate(x,y) rotate(rot) scale(-1,1)`.
 */
export function transformLocalPt(pt: Pt, place: SchPlace): Pt {
  const mx = place.mirror ? -pt.x : pt.x;
  const my = pt.y;
  let rx: number;
  let ry: number;
  switch (place.rot) {
    case 0:
      rx = mx;
      ry = my;
      break;
    case 90:
      rx = -my;
      ry = mx;
      break;
    case 180:
      rx = -mx;
      ry = -my;
      break;
    case 270:
      rx = my;
      ry = -mx;
      break;
  }
  return { x: place.x + rx, y: place.y + ry };
}

export function transformDir(dir: Dir, place: SchPlace): Dir {
  let d = dir;
  if (place.mirror) {
    if (d === 'L') d = 'R';
    else if (d === 'R') d = 'L';
  }
  const steps = place.rot / 90;
  const ring: Dir[] = ['R', 'D', 'L', 'U'];
  const idx = ring.indexOf(d);
  return ring[(idx + steps) % 4]!;
}

export function dirDelta(dir: Dir): Pt {
  switch (dir) {
    case 'L': return { x: -1, y: 0 };
    case 'R': return { x: 1, y: 0 };
    case 'U': return { x: 0, y: -1 };
    case 'D': return { x: 0, y: 1 };
  }
}

export function transformBox(local: GridBox, place: SchPlace): GridBox {
  const corners = [
    transformLocalPt({ x: local.minX, y: local.minY }, place),
    transformLocalPt({ x: local.maxX, y: local.minY }, place),
    transformLocalPt({ x: local.minX, y: local.maxY }, place),
    transformLocalPt({ x: local.maxX, y: local.maxY }, place),
  ];
  return {
    minX: Math.min(...corners.map(c => c.x)),
    minY: Math.min(...corners.map(c => c.y)),
    maxX: Math.max(...corners.map(c => c.x)),
    maxY: Math.max(...corners.map(c => c.y)),
  };
}

export function boxesOverlap(a: GridBox, b: GridBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
