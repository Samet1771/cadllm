// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Query } from '@cadllm/core';
import { pads as resolvePads, type PadInstance } from '@cadllm/pcb';
import { projectName, type ExportOptions } from './gerber.ts';

interface DrillHit {
  x: number;
  y: number;
  drill: number;
  key: string;
}

const fmt4 = (n: number): string => {
  const v = Math.abs(n) < 1e-9 ? 0 : n;
  return v.toFixed(4);
};

function buildExcellonFile(kind: 'PTH' | 'NPTH', hits: DrillHit[]): string {
  const byDiam = new Map<string, { diameter: number; hits: DrillHit[] }>();
  for (const h of hits) {
    const dKey = fmt4(h.drill);
    let group = byDiam.get(dKey);
    if (!group) {
      group = { diameter: Number(dKey), hits: [] };
      byDiam.set(dKey, group);
    }
    group.hits.push(h);
  }

  const tools = [...byDiam.values()].sort((a, b) => a.diameter - b.diameter);
  const lines: string[] = [
    'M48',
    `; DRILL file {CadLLM} ${kind}`,
    'METRIC,TZ',
  ];

  for (let i = 0; i < tools.length; i++) {
    lines.push(`T${i + 1}C${fmt4(tools[i]!.diameter)}`);
  }
  lines.push('%', 'G05');

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    lines.push(`T${i + 1}`);
    const sortedHits = [...tool.hits].sort(
      (a, b) => naturalCompare(a.key, b.key) || a.x - b.x || a.y - b.y,
    );
    for (const h of sortedHits) {
      lines.push(`X${fmt4(h.x)}Y${fmt4(h.y)}`);
    }
  }

  lines.push('M30');
  return `${lines.join('\n')}\n`;
}

/** Generate Excellon drill files (`<project>-PTH.drl` and `<project>-NPTH.drl`) keyed by filename. */
export function excellon(q: Query, opts?: ExportOptions): Record<string, string> {
  const proj = projectName(q, opts);
  const padList: PadInstance[] = opts?.pads ?? resolvePads(q);

  const pthHits: DrillHit[] = [];
  const npthHits: DrillHit[] = [];

  for (const pad of padList) {
    if (pad.drill === undefined || pad.drill <= 0) continue;
    const hit: DrillHit = {
      x: pad.at[0],
      y: pad.at[1],
      drill: pad.drill,
      key: `0:${pad.ref}:${pad.pinId}`,
    };
    if (pad.layers === 'TH') pthHits.push(hit);
    else npthHits.push(hit);
  }

  const vias = q.circuit.pcb?.vias ?? [];
  for (let i = 0; i < vias.length; i++) {
    const via = vias[i]!;
    if (via.drill <= 0) continue;
    pthHits.push({
      x: via.at[0],
      y: via.at[1],
      drill: via.drill,
      key: `1:via:${i}:${fmt4(via.at[0])},${fmt4(via.at[1])}`,
    });
  }

  return {
    [`${proj}-PTH.drl`]: buildExcellonFile('PTH', pthHits),
    [`${proj}-NPTH.drl`]: buildExcellonFile('NPTH', npthHits),
  };
}
