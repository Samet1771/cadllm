// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { breadboard } from './bb/index.ts';
import { schematic } from './sch/index.ts';
import type { View, ViewId, ViewIssue } from './types.ts';

export * from './types.ts';
export { el, esc, num, path, svgDoc } from './svg.ts';
export { schematic } from './sch/index.ts';
export { breadboard, bbHoleAt, bbHolePos } from './bb/index.ts';

export const VIEWS: Record<ViewId, View> = { sch: schematic, bb: breadboard };

export function view(id: string): View {
  const v = VIEWS[id as ViewId];
  if (!v) throw new Error(`unknown view ${id} (sch, bb)`);
  return v;
}

/** View checks for every view the circuit uses (any component placed there). */
export function viewChecks(q: Query): ViewIssue[] {
  const used = new Set(q.components().flatMap(c => Object.keys(c.place)));
  return (Object.keys(VIEWS) as ViewId[]).filter(v => used.has(v)).flatMap(v => VIEWS[v].check(q));
}
