// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Doc, type PartDef, type PartResolver, type Query } from '@cadllm/core';

const partsDir = resolve(import.meta.dirname, '../../../parts');
const byId = new Map<string, PartDef>();

function loadDir(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadDir(full);
    else if (entry.name.endsWith('.json')) {
      const part = JSON.parse(readFileSync(full, 'utf8')) as PartDef;
      byId.set(part.id, part);
    }
  }
}

loadDir(partsDir);

/** Real part library loaded directly from `parts/*.json` without external package deps. */
export const lib: PartResolver = {
  get: id => byId.get(id),
};

export const allParts = (): PartDef[] => [...byId.values()];

export function build(fn: (tx: Parameters<Doc['transact']>[0] extends (tx: infer T) => void ? T : never) => void): Query {
  const doc = new Doc(lib);
  doc.transact(fn);
  return doc.read;
}
