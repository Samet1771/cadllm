// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PartDef, PartResolver } from '@cadllm/core';
import { validatePart } from './validate.ts';

export interface Library extends PartResolver {
  all(): PartDef[];
  search(q: string, limit?: number): PartDef[];
  summaryLine(p: PartDef): string;
}

function scoreField(text: string, token: string, exactW: number, prefixW: number, subW: number): number {
  const s = text.toLowerCase();
  if (s === token) return exactW;
  if (s.startsWith(token)) return prefixW;
  const words = s.split(/[^a-z0-9_+.-]+/);
  for (const w of words) {
    if (w === token) return exactW * 0.8;
    if (w.startsWith(token)) return prefixW * 0.8;
  }
  if (s.includes(token)) return subW;
  return 0;
}

function scorePart(p: PartDef, tokens: string[]): { matched: number; score: number } {
  let matched = 0;
  let score = 0;
  for (const t of tokens) {
    let best = Math.max(
      scoreField(p.id, t, 100, 60, 30),
      scoreField(p.name, t, 50, 30, 15),
      scoreField(p.category, t, 25, 15, 6),
      scoreField(p.summary, t, 20, 14, 8),
    );
    for (const kw of p.keywords ?? []) best = Math.max(best, scoreField(kw, t, 40, 24, 10));
    for (const fp of p.footprints ?? []) best = Math.max(best, scoreField(fp, t, 25, 18, 8));
    if (best > 0) {
      matched += 1;
      score += best;
    }
  }
  return { matched, score };
}

export function summaryLine(p: PartDef): string {
  const pinFp = p.footprints?.length ? `${p.pins.length}p ${p.footprints.join('/')}` : `${p.pins.length}p`;
  const parts = [p.id, p.summary, pinFp];
  if (p.sim?.length) {
    const kinds = [...new Set(p.sim.map(s => s.kind))].join(',');
    parts.push(`sim:${kinds}`);
  }
  return parts.join('  ');
}

/** Create an in-memory Library from PartDefs. Later entries override earlier ones with the same id. */
export function createLibrary(parts: PartDef[]): Library {
  const byId = new Map<string, PartDef>();
  for (const p of parts) {
    const problems = validatePart(p);
    if (problems.length) throw new Error(`invalid part ${String((p as Partial<PartDef>).id ?? '?')}: ${problems.join('; ')}`);
    byId.set(p.id, p);
  }
  const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    get: id => byId.get(id),
    all: () => sorted,
    summaryLine,
    search(q: string, limit = 20): PartDef[] {
      const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return sorted.slice(0, limit);
      const hits: { part: PartDef; matched: number; score: number }[] = [];
      for (const part of sorted) {
        const { matched, score } = scorePart(part, tokens);
        if (matched > 0) hits.push({ part, matched, score });
      }
      hits.sort((a, b) =>
        b.matched - a.matched || b.score - a.score || (a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0)
      );
      return hits.slice(0, limit).map(h => h.part);
    },
  };
}

function collectJsonFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectJsonFiles(full));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Recursively load and validate all *.json part files from dirs. Later dirs override earlier ids. */
export function loadLibrary(dirs: string[]): Library {
  const parts: PartDef[] = [];
  for (const dir of dirs) {
    for (const file of collectJsonFiles(dir)) {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const problems = validatePart(raw);
      if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
      parts.push(raw as PartDef);
    }
  }
  return createLibrary(parts);
}
