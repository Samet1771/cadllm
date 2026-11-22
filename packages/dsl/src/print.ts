// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { isEmptyDelta, naturalCompare, type Component, type Doc, type Net, type Query, type TxInfo } from '@cadllm/core';
import { CODE_META_PREFIX, TESTS_META_KEY } from './edit.ts';
import { quoteValue } from './lexer.ts';

export interface PrintOptions {
  select?: string[];
  detail?: 0 | 1 | 2;
  place?: boolean;
}

const VIEW_SECTIONS: [view: string, section: string][] = [
  ['bb', 'breadboard'],
  ['sch', 'schematic'],
  ['pcb', 'pcb'],
];

function selectItems(q: Query, select?: string[]): { comps: Component[]; nets: Net[] } {
  const allComps = q.components();
  const allNets = q.nets();
  if (!select) return { comps: allComps, nets: allNets };

  const wantRefs = new Set<string>();
  const wantNets = new Set<string>();
  for (const s of select) {
    if (s.toLowerCase().startsWith('net:')) wantNets.add(s.slice(4).toUpperCase());
    else wantRefs.add(s.toUpperCase());
  }
  return {
    comps: allComps.filter(c => wantRefs.has(c.ref.toUpperCase())),
    nets: allNets.filter(n => wantNets.has(n.name.toUpperCase())),
  };
}

function formatSummary(comps: Component[], nets: Net[]): string {
  const counts = new Map<string, number>();
  for (const c of comps) counts.set(c.part, (counts.get(c.part) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]))
    .map(([part, n]) => (n > 1 ? `${part}×${n}` : part));
  const head = `${comps.length} ${comps.length === 1 ? 'comp' : 'comps'} ${nets.length} ${nets.length === 1 ? 'net' : 'nets'}`;
  return parts.length ? `${head} · parts: ${parts.join(' ')}` : head;
}

function compTailTokens(q: Query, comp: Component, detail: 1 | 2, place: boolean): string[] {
  const part = q.parts.get(comp.part);
  const tokens: string[] = [];
  const vp = part?.valueProp;

  if (vp && comp.props[vp] !== undefined) {
    tokens.push(quoteValue(comp.props[vp]!, /^[=@]/));
  }

  const propKeys = Object.keys(comp.props)
    .filter(k => k !== vp)
    .sort(naturalCompare);
  for (const k of propKeys) {
    const val = comp.props[k]!;
    if (detail === 1 && part?.props?.[k]?.default === val) continue;
    tokens.push(`${k}=${quoteValue(val)}`);
  }

  if (place) {
    for (const view of Object.keys(comp.place).sort(naturalCompare)) {
      tokens.push(`@${view}:${quoteValue(comp.place[view]!)}`);
    }
  }
  return tokens;
}

/** Print circuit components and nets in deterministic natural order. */
export function printCircuit(q: Query, opts: PrintOptions = {}): string {
  const detail = opts.detail ?? 1;
  const { comps, nets } = selectItems(q, opts.select);
  if (detail === 0) return formatSummary(comps, nets);

  const lines: string[] = [];
  if (comps.length > 0) {
    const maxRef = Math.max(...comps.map(c => c.ref.length));
    const maxPart = Math.max(...comps.map(c => c.part.length));
    for (const c of comps) {
      const tail = compTailTokens(q, c, detail, opts.place ?? false);
      if (tail.length === 0) {
        lines.push(`${c.ref.padEnd(maxRef)} ${c.part}`);
      } else {
        lines.push(`${c.ref.padEnd(maxRef)} ${c.part.padEnd(maxPart)} ${tail.join(' ')}`);
      }
    }
  }

  if (comps.length > 0 && nets.length > 0) lines.push('');

  if (nets.length > 0) {
    const maxNet = Math.max(...nets.map(n => n.name.length + 1));
    for (const n of nets) {
      const pins = q.sortedPins(n).join(' ');
      const header = `${n.name}:`;
      lines.push(pins ? `${header.padEnd(maxNet)} ${pins}` : header);
    }
  }

  return lines.join('\n');
}

/** Format a transaction delta into one token-cheap status line. */
export function printDelta(info: TxInfo, _q: Query): string {
  const d = info.delta;
  const parts: string[] = [];

  for (const ref of [...d.added].sort(naturalCompare)) parts.push(`+${ref}`);
  for (const ref of [...d.removed].sort(naturalCompare)) parts.push(`-${ref}`);
  for (const ref of [...d.changed].sort(naturalCompare)) parts.push(`~${ref}`);
  for (const [from, to] of [...d.renamed].sort((a, b) => naturalCompare(a[0], b[0]))) parts.push(`${from}>${to}`);

  const netParts: string[] = [];
  for (const n of [...d.netsAdded].sort(naturalCompare)) netParts.push(`+${n}`);
  for (const n of [...d.netsRemoved].sort(naturalCompare)) netParts.push(`-${n}`);
  for (const n of [...d.netsChanged].sort(naturalCompare)) netParts.push(`~${n}`);
  for (const [from, to] of [...d.netsRenamed].sort((a, b) => naturalCompare(a[0], b[0]))) netParts.push(`${from}>${to}`);
  if (netParts.length > 0) parts.push(`nets: ${netParts.join(' ')}`);

  const notes = info.notes.length > 0 ? ` · ${info.notes.join(' · ')}` : '';
  if (isEmptyDelta(d) && info.notes.length === 0) return `ok rev=${info.rev} (no change)`;
  if (parts.length === 0) return `ok rev=${info.rev}${notes}`;
  return `ok rev=${info.rev} ${parts.join(' ')}${notes}`;
}

/** Serialize a Doc into a canonical `.cnl` file. */
export function saveCnl(doc: Doc): string {
  const q = doc.read;
  const blocks: string[] = [];

  const headerLines = ['cnl 1'];
  const metaKeys = Object.keys(q.circuit.meta)
    .filter(k => k !== TESTS_META_KEY && !k.startsWith(CODE_META_PREFIX))
    .sort(naturalCompare);
  if (metaKeys.length > 0) {
    headerLines.push(`meta ${metaKeys.map(k => `${k}=${quoteValue(q.circuit.meta[k]!)}`).join(' ')}`);
  }
  blocks.push(headerLines.join('\n'));

  const circuitBody = printCircuit(q, { detail: 1, place: false });
  blocks.push(circuitBody ? `[circuit]\n${circuitBody}` : '[circuit]');

  const comps = q.components();
  for (const [view, section] of VIEW_SECTIONS) {
    const withView = comps.filter(c => c.place[view] !== undefined);
    if (withView.length === 0) continue;
    const maxRef = Math.max(...withView.map(c => c.ref.length));
    const sectionLines = [`[${section}]`];
    for (const c of withView) {
      const pos = c.place[view]!;
      const formattedPos = pos === '' || pos !== pos.trim() || /[;#"\n\t\\]/.test(pos) ? quoteValue(pos) : pos;
      sectionLines.push(`${c.ref.padEnd(maxRef)} @${formattedPos}`);
    }
    blocks.push(sectionLines.join('\n'));
  }

  const codeEntries = Object.keys(q.circuit.meta)
    .filter(k => k.startsWith(CODE_META_PREFIX))
    .map(k => ({ ref: k.slice(CODE_META_PREFIX.length), code: q.circuit.meta[k]! }))
    .filter(e => e.code.trim() !== '')
    .sort((a, b) => naturalCompare(a.ref, b.ref));
  for (const { ref, code } of codeEntries) {
    const trimmed = code.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
    blocks.push(`[code ${ref}]\n${trimmed}`);
  }

  const testsText = q.circuit.meta[TESTS_META_KEY];
  if (testsText !== undefined && testsText.trim() !== '') {
    blocks.push(`[tests]\n${testsText.trim()}`);
  }

  return `${blocks.join('\n\n')}\n`;
}
