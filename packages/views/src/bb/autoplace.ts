// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Component, type Query } from '@cadllm/core';
import { UNIT, type PlaceOptions, type PlaceResult } from '../types.ts';
import {
  MAIN_ROWS,
  resolveBoard,
  stripOfHole,
  parseHole,
  type MainRow,
} from './board.ts';
import {
  defaultPitchFor,
  familyOf,
  isOffBoardOnly,
  resolveCompPlace,
  type Box,
} from './place.ts';

const ROW_PREF: MainRow[] = ['C', 'B', 'D', 'A', 'H', 'I', 'G', 'J', 'E', 'F'];
const TALL_FAMILIES = new Set(['button', 'slide_switch', 'buzzer', 'pot', 'led']);

function rowScore(r: MainRow): number {
  if (r === 'B' || r === 'C' || r === 'H' || r === 'I') return 6;
  if (r === 'A' || r === 'D' || r === 'G' || r === 'J') return 4;
  return 0;
}

function rowIndex(r: MainRow): number {
  return MAIN_ROWS.indexOf(r);
}

function sameHalf(a: MainRow, b: MainRow): boolean {
  return (a <= 'E') === (b <= 'E');
}

function boxesOverlap(a: Box, b: Box, pad = UNIT): boolean {
  return !(
    a.x + a.w + pad <= b.x
    || b.x + b.w + pad <= a.x
    || a.y + a.h + pad <= b.y
    || b.y + b.h + pad <= a.y
  );
}

interface PlacedBodySpan {
  row: MainRow;
  minCol: number;
  maxCol: number;
  tall: boolean;
  dip: boolean;
}

export function autoPlace(q: Query, opts: PlaceOptions = {}): PlaceResult {
  const board = resolveBoard(q);
  const onlyRefs = opts.refs ? new Set(opts.refs.map(r => r.toUpperCase())) : undefined;
  const comps = q.components();

  const occupiedHoles = new Set<string>();
  const stripOwner = new Map<string, string>();
  const stripCount = new Map<string, number>();
  const placedBodies: PlacedBodySpan[] = [];
  const offBoardBoxes: Box[] = [];
  const netCols = new Map<string, number[]>();

  const pinNetKey = (comp: Component, pinId: string): string => {
    const net = q.netOfPin(`${comp.id}:${pinId}`);
    return net ? `net:${net.id}` : `nc:${comp.id}:${pinId}`;
  };

  const reserveHole = (hole: string, netKey: string, stripId: string) => {
    occupiedHoles.add(hole);
    if (!stripOwner.has(stripId)) stripOwner.set(stripId, netKey);
    stripCount.set(stripId, (stripCount.get(stripId) ?? 0) + 1);
    const parsed = parseHole(hole);
    if (parsed && netKey.startsWith('net:')) {
      const list = netCols.get(netKey) ?? [];
      list.push(parsed.col);
      netCols.set(netKey, list);
    }
  };

  const canUseHole = (hole: string, netKey: string, stripId: string): boolean => {
    if (occupiedHoles.has(hole)) return false;
    const owner = stripOwner.get(stripId);
    if (owner !== undefined && owner !== netKey) return false;
    return true;
  };

  const bodyPenalty = (row: MainRow, minCol: number, maxCol: number, fam: string): number => {
    const isTall = TALL_FAMILIES.has(fam);
    const rIdx = rowIndex(row);
    let pen = 0;

    for (const pb of placedBodies) {
      const overlapCols = Math.max(0, Math.min(maxCol, pb.maxCol) - Math.max(minCol, pb.minCol) + 1);
      if (overlapCols === 0) continue;

      if (pb.row === row) {
        pen += overlapCols * 90;
      } else if (sameHalf(row, pb.row) && Math.abs(rIdx - rowIndex(pb.row)) === 1) {
        if (pb.dip) {
          // DIP sits in center channel; tall parts (buttons) shouldn't crowd row D/G right against E/F
          pen += overlapCols * (isTall ? 45 : 10);
        } else {
          // Prefer leaving a free row between parallel components
          pen += overlapCols * (isTall || pb.tall ? 45 : 28);
        }
      }
    }
    return pen;
  };

  const shouldPlace = (c: Component): boolean => {
    const fam = familyOf(q, c);
    if (fam === 'breadboard' || fam === 'none') return false;
    if (onlyRefs && !onlyRefs.has(c.ref.toUpperCase())) return false;
    if (!opts.all && c.place.bb?.trim()) return false;
    return true;
  };

  const toPlace: Component[] = [];
  const fixed: Component[] = [];

  for (const c of comps) {
    const fam = familyOf(q, c);
    if (fam === 'breadboard' || fam === 'none') continue;
    if (shouldPlace(c)) toPlace.push(c);
    else fixed.push(c);
  }

  // Register fixed components first
  for (const c of fixed) {
    const res = resolveCompPlace(q, board, c);
    if (!res.placed) continue;
    if (res.placed.offBoard) {
      offBoardBoxes.push(res.placed.box);
      continue;
    }
    for (const p of res.placed.pins) {
      if (p.onBoard && p.hole && p.strip) {
        reserveHole(p.hole, pinNetKey(c, p.pin.id), p.strip.id);
      }
    }
    if (res.placed.family === 'dip') {
      const cols = res.placed.pins.map(p => p.parsedHole?.col ?? 0).filter(Boolean);
      const minCol = Math.min(...cols);
      const maxCol = Math.max(...cols);
      placedBodies.push({ row: 'E', minCol, maxCol, tall: true, dip: true });
      placedBodies.push({ row: 'F', minCol, maxCol, tall: true, dip: true });
    } else if (res.placed.pins.length >= 1) {
      const rows = new Set(res.placed.pins.map(p => p.parsedHole?.row));
      if (rows.size === 1 && res.placed.pins[0]!.parsedHole) {
        const r = res.placed.pins[0]!.parsedHole.row;
        if (r.length === 1) {
          const cols = res.placed.pins.map(p => p.parsedHole!.col);
          placedBodies.push({
            row: r as MainRow,
            minCol: Math.min(...cols),
            maxCol: Math.max(...cols),
            tall: TALL_FAMILIES.has(res.placed.family),
            dip: false,
          });
        }
      }
    }
  }

  const place: Record<string, string> = {};
  const notes: string[] = [];

  // 1. Place off-board sources and boards on the left
  const offComps = toPlace.filter(c => isOffBoardOnly(familyOf(q, c)));
  let nextOffY = 2;
  for (const c of offComps) {
    const fam = familyOf(q, c);
    const wPitch = fam === 'arduino_uno' ? 22 : fam === 'supply' ? 7 : 6;
    const hPitch = fam === 'arduino_uno' ? 16 : fam === 'supply' ? 4.6 : 4;
    const xPitch = -(wPitch + 2);
    let yPitch = nextOffY;
    while (
      offBoardBoxes.some(b =>
        boxesOverlap(b, { x: xPitch * UNIT, y: yPitch * UNIT, w: wPitch * UNIT, h: hPitch * UNIT }),
      )
    ) {
      yPitch += 2;
    }
    place[c.ref] = `${xPitch},${yPitch}`;
    offBoardBoxes.push({ x: xPitch * UNIT, y: yPitch * UNIT, w: wPitch * UNIT, h: hPitch * UNIT });
    nextOffY = Math.ceil(yPitch + hPitch + 2);
  }

  // 2. Place DIP ICs straddling the center channel (row E), left to right
  const dipComps = toPlace.filter(c => familyOf(q, c) === 'dip');
  let nextDipCol = 6;
  for (const c of dipComps) {
    const part = q.parts.get(c.part);
    const pinCount = part?.pins.length ?? 8;
    const half = Math.max(1, Math.floor(pinCount / 2));
    let placedCol: number | undefined;

    for (let startCol = Math.max(1, nextDipCol); startCol + half - 1 <= board.cols; startCol++) {
      let ok = true;
      const localOwners = new Map<string, string>();
      for (let i = 0; i < pinCount; i++) {
        const pin = part!.pins[i]!;
        const isTop = i < half;
        const col = isTop ? startCol + i : startCol + (pinCount - 1 - i);
        const hole = `${isTop ? 'E' : 'F'}${col}`;
        const stripId = `strip:${isTop ? 'T' : 'B'}:${col}`;
        const nk = pinNetKey(c, pin.id);
        if (!canUseHole(hole, nk, stripId)) {
          ok = false;
          break;
        }
        const prev = localOwners.get(stripId);
        if (prev !== undefined && prev !== nk) {
          ok = false;
          break;
        }
        localOwners.set(stripId, nk);
      }
      if (ok) {
        placedCol = startCol;
        break;
      }
    }

    if (placedCol !== undefined) {
      place[c.ref] = `E${placedCol}`;
      for (let i = 0; i < pinCount; i++) {
        const pin = part!.pins[i]!;
        const isTop = i < half;
        const col = isTop ? placedCol + i : placedCol + (pinCount - 1 - i);
        const hole = `${isTop ? 'E' : 'F'}${col}`;
        const stripId = `strip:${isTop ? 'T' : 'B'}:${col}`;
        reserveHole(hole, pinNetKey(c, pin.id), stripId);
      }
      placedBodies.push({ row: 'E', minCol: placedCol, maxCol: placedCol + half - 1, tall: true, dip: true });
      placedBodies.push({ row: 'F', minCol: placedCol, maxCol: placedCol + half - 1, tall: true, dip: true });
      nextDipCol = placedCol + half + 4;
    } else {
      place[c.ref] = `-12,${nextOffY}`;
      nextOffY += 6;
      notes.push(`${c.ref}: no room on channel, placed off-board`);
    }
  }

  // 3. Place remaining parts greedily by connectivity to already-placed parts
  const remaining = toPlace.filter(c => {
    const fam = familyOf(q, c);
    return !isOffBoardOnly(fam) && fam !== 'dip';
  });

  const connScoreToPlaced = (c: Component): number => {
    const part = q.parts.get(c.part);
    if (!part) return 0;
    let score = 0;
    for (const p of part.pins) {
      const nk = pinNetKey(c, p.id);
      if (netCols.has(nk)) score += 1;
    }
    return score;
  };

  const pending = [...remaining];
  while (pending.length > 0) {
    pending.sort((a, b) => connScoreToPlaced(b) - connScoreToPlaced(a) || naturalCompare(a.ref, b.ref));
    const c = pending.shift()!;
    const part = q.parts.get(c.part);
    const fam = familyOf(q, c);
    const pins = part?.pins ?? [
      { id: '1', name: '1', type: 'passive' as const },
      { id: '2', name: '2', type: 'passive' as const },
    ];
    const pitch = defaultPitchFor(fam);

    if (pins.length === 2) {
      const nk1 = pinNetKey(c, pins[0]!.id);
      const nk2 = pinNetKey(c, pins[1]!.id);
      const n1Cols = netCols.get(nk1) ?? [];
      const n2Cols = netCols.get(nk2) ?? [];
      const minSpan = Math.max(1, pitch - 1);
      const maxSpan = pitch + 2;

      let best: { score: number; r1: MainRow; c1: number; r2: MainRow; c2: number } | undefined;

      const evaluate = (r1: MainRow, c1: number, r2: MainRow, c2: number) => {
        if (c1 < 1 || c1 > board.cols || c2 < 1 || c2 > board.cols) return;
        const h1 = `${r1}${c1}`;
        const h2 = `${r2}${c2}`;
        const s1 = stripOfHole(parseHole(h1)!).id;
        const s2 = stripOfHole(parseHole(h2)!).id;
        if (s1 === s2) return;
        if (!canUseHole(h1, nk1, s1) || !canUseHole(h2, nk2, s2)) return;

        // Keep at least 1 free hole in each strip for a potential jumper
        if ((stripCount.get(s1) ?? 0) >= 4 && !stripOwner.has(s1)) return;
        if ((stripCount.get(s2) ?? 0) >= 4 && !stripOwner.has(s2)) return;

        let score = 0;
        if (stripOwner.get(s1) === nk1) score += 120;
        if (stripOwner.get(s2) === nk2) score += 120;

        const span = Math.abs(c2 - c1);
        if (r1 === r2) {
          score += span === pitch ? 30 : -8 * Math.abs(span - pitch);
          if (c1 < c2) score += 12;
          score -= bodyPenalty(r1, Math.min(c1, c2), Math.max(c1, c2), fam);
          score += rowScore(r1);
        } else {
          score += pitch <= 3 ? 10 : -20;
          score -= bodyPenalty(r1, c1, c1, fam) + bodyPenalty(r2, c2, c2, fam);
        }

        for (const tc of n1Cols) score -= Math.abs(c1 - tc) * 0.6;
        for (const tc of n2Cols) score -= Math.abs(c2 - tc) * 0.6;

        // Leave left-edge cols 1-3 free for rail-to-rail bridges and power entry
        if (c1 <= 3 || c2 <= 3) score -= 8;

        if (!best || score > best.score + 1e-6) {
          best = { score, r1, c1, r2, c2 };
        }
      };

      for (const r of ROW_PREF) {
        for (let c1 = 1; c1 <= board.cols; c1++) {
          for (let span = minSpan; span <= maxSpan; span++) {
            evaluate(r, c1, r, c1 + span);
            evaluate(r, c1, r, c1 - span);
          }
        }
      }
      if (pitch <= 3) {
        for (let col = 1; col <= board.cols; col++) {
          evaluate('E', col, 'F', col);
          evaluate('F', col, 'E', col);
        }
      }

      if (best) {
        const h1 = `${best.r1}${best.c1}`;
        const h2 = `${best.r2}${best.c2}`;
        const s1 = stripOfHole(parseHole(h1)!).id;
        const s2 = stripOfHole(parseHole(h2)!).id;
        reserveHole(h1, nk1, s1);
        reserveHole(h2, nk2, s2);
        if (best.r1 === best.r2) {
          placedBodies.push({
            row: best.r1,
            minCol: Math.min(best.c1, best.c2),
            maxCol: Math.max(best.c1, best.c2),
            tall: TALL_FAMILIES.has(fam),
            dip: false,
          });
        }
        place[c.ref] = best.r1 === best.r2 && best.c2 === best.c1 + pitch ? h1 : `${h1}-${h2}`;
        continue;
      }
    } else {
      // 1-pin, 3-pin (TO-92, pot), or N-pin inline
      const n = pins.length;
      let best: { score: number; row: MainRow; col: number } | undefined;

      for (const r of ROW_PREF) {
        for (let startCol = 1; startCol + (n - 1) * pitch <= board.cols; startCol++) {
          let ok = true;
          let score = rowScore(r);
          for (let i = 0; i < n; i++) {
            const col = startCol + i * pitch;
            const hole = `${r}${col}`;
            const stripId = stripOfHole(parseHole(hole)!).id;
            const nk = pinNetKey(c, pins[i]!.id);
            if (!canUseHole(hole, nk, stripId)) {
              ok = false;
              break;
            }
            if (stripOwner.get(stripId) === nk) score += 120;
            for (const tc of netCols.get(nk) ?? []) score -= Math.abs(col - tc) * 0.6;
          }
          if (!ok) continue;
          const endCol = startCol + (n - 1) * pitch;
          score -= bodyPenalty(r, startCol, endCol, fam);
          if (startCol <= 3) score -= 8;
          if (!best || score > best.score + 1e-6) {
            best = { score, row: r, col: startCol };
          }
        }
      }

      if (best) {
        for (let i = 0; i < n; i++) {
          const col = best.col + i * pitch;
          const hole = `${best.row}${col}`;
          const stripId = stripOfHole(parseHole(hole)!).id;
          reserveHole(hole, pinNetKey(c, pins[i]!.id), stripId);
        }
        placedBodies.push({
          row: best.row,
          minCol: best.col,
          maxCol: best.col + (n - 1) * pitch,
          tall: TALL_FAMILIES.has(fam),
          dip: false,
        });
        place[c.ref] = `${best.row}${best.col}`;
        continue;
      }
    }

    // Fallback off-board if board is completely full
    const wPitch = Math.max(3, pins.length + 1);
    const xPitch = -(wPitch + 2);
    const yPitch = nextOffY;
    place[c.ref] = `${xPitch},${yPitch}`;
    offBoardBoxes.push({ x: xPitch * UNIT, y: yPitch * UNIT, w: wPitch * UNIT, h: 3 * UNIT });
    nextOffY += 5;
    notes.push(`${c.ref}: board full, placed off-board`);
  }

  return { place, notes };
}
