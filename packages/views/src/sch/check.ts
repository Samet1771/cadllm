// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import type { ViewIssue } from '../types.ts';
import { resolveSchFamily } from './nets.ts';
import { boxesOverlap, parseSchPlace } from './place.ts';
import { buildSymbol } from './symbols/index.ts';
import type { PlacedSymbol } from './types.ts';

export function checkSchematic(q: Query): ViewIssue[] {
  const issues: ViewIssue[] = [];
  const unplaced: string[] = [];
  const placed: PlacedSymbol[] = [];

  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part) continue;
    const family = resolveSchFamily(part);
    if (family === 'none') continue;

    const raw = comp.place['sch'];
    if (raw === undefined || raw.trim() === '') {
      unplaced.push(comp.ref);
      continue;
    }

    const parsed = parseSchPlace(raw);
    if (!parsed) {
      issues.push({
        level: 'error',
        code: 'bad_place',
        message: `${comp.ref}: invalid schematic placement "${raw}" (expected x,y[,rot][,m])`,
        at: [comp.ref],
      });
      continue;
    }

    placed.push(buildSymbol(q, comp, part, parsed));
  }

  if (unplaced.length > 0) {
    issues.push({
      level: 'warn',
      code: 'unplaced',
      message: `unplaced in schematic: ${unplaced.join(', ')}`,
      at: unplaced,
    });
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (boxesOverlap(a.bodyBox, b.bodyBox)) {
        issues.push({
          level: 'warn',
          code: 'overlap',
          message: `${a.comp.ref} and ${b.comp.ref} overlap`,
          at: [a.comp.ref, b.comp.ref],
        });
      }
    }
  }

  return issues;
}
