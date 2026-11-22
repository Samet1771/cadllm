// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PartDef, PartResolver } from '@cadllm/core';

export interface FindHit {
  id: string;
  summary: string;
  pins: string;
  sim?: string;
  part?: PartDef;
}

/** Build a browser-safe PartResolver from `library` RPC results and `state.parts`. */
export function buildPartResolver(
  libraryParts: PartDef[],
  stateParts?: Record<string, PartDef>,
): PartResolver {
  const byId = new Map<string, PartDef>();
  const byLower = new Map<string, PartDef>();
  const add = (p: PartDef) => {
    byId.set(p.id, p);
    byLower.set(p.id.toLowerCase(), p);
  };
  for (const p of libraryParts) add(p);
  if (stateParts) {
    for (const p of Object.values(stateParts)) add(p);
  }
  return {
    get: (id: string) => byId.get(id) ?? byLower.get(id.toLowerCase()),
  };
}

/** Parse compact `find` tool text output into structured rows. */
export function parseFindOutput(text: string, resolver?: PartResolver): FindHit[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('no parts match')) return [];
  const hits: FindHit[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('…')) continue;
    const cols = line.split(/\s{2,}/);
    const id = cols[0];
    if (!id) continue;
    const summary = cols[1] ?? '';
    const pins = cols[2] ?? '';
    const sim = cols[3];
    hits.push({
      id,
      summary,
      pins,
      ...(sim ? { sim } : {}),
      ...(resolver?.get(id) ? { part: resolver.get(id) } : {}),
    });
  }
  return hits;
}

/** Extract `rev=N` from engine text replies (e.g. `ok rev=13 +R1` or `untitled rev=2`). */
export function parseRevFromText(text: string): number | undefined {
  const m = text.match(/\brev=(\d+)\b/);
  return m ? Number(m[1]) : undefined;
}

/** Strip the `project rev=N` header line produced by `read` so the body is directly editable CNL. */
export function stripReadHeader(text: string): string {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  if (/^\S+\s+rev=\d+(?:\s+\(empty\))?$/.test(first)) {
    return lines.slice(1).join('\n').trim();
  }
  return text.trim();
}
