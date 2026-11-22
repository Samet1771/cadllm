// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { DEFAULT_PCB_RULES, isEmptyDelta, naturalCompare, type Component, type Doc, type Net, type Query, type TxInfo } from '@cadllm/core';
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
  if (d.pcbNets.length > 0) parts.push(`pcb: ${[...d.pcbNets].sort(naturalCompare).map(n => `~${n}`).join(' ')}`);

  const notes = info.notes.length > 0 ? ` · ${info.notes.join(' · ')}` : '';
  if (isEmptyDelta(d) && info.notes.length === 0) return `ok rev=${info.rev} (no change)`;
  if (parts.length === 0) return `ok rev=${info.rev}${notes}`;
  return `ok rev=${info.rev} ${parts.join(' ')}${notes}`;
}

const fmtMm = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};

function formatBoardLine(outline: [number, number][]): string {
  if (outline.length === 4) {
    const [p0, p1, p2, p3] = outline as [[number, number], [number, number], [number, number], [number, number]];
    if (
      p0[0] === 0 && p0[1] === 0
      && p1[0] > 0 && p1[1] === 0
      && p2[0] === p1[0] && p2[1] > 0
      && p3[0] === 0 && p3[1] === p2[1]
    ) {
      return `board ${fmtMm(p1[0])}x${fmtMm(p2[1])}`;
    }
  }
  return `board ${outline.map(([x, y]) => `${fmtMm(x)},${fmtMm(y)}`).join(' ')}`;
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
    const pcb = view === 'pcb' ? q.circuit.pcb : undefined;
    const hasPcbData = pcb !== undefined && (
      pcb.board !== undefined
      || pcb.rules !== undefined
      || pcb.tracks.length > 0
      || pcb.vias.length > 0
    );
    if (withView.length === 0 && !hasPcbData) continue;

    const sectionLines = [`[${section}]`];
    if (withView.length > 0) {
      const maxRef = Math.max(...withView.map(c => c.ref.length));
      for (const c of withView) {
        const pos = c.place[view]!;
        const formattedPos = pos === '' || pos !== pos.trim() || /[;#"\n\t\\]/.test(pos) ? quoteValue(pos) : pos;
        sectionLines.push(`${c.ref.padEnd(maxRef)} @${formattedPos}`);
      }
    }
    if (pcb) {
      if (pcb.board) sectionLines.push(formatBoardLine(pcb.board.outline));
      if (pcb.rules) {
        const r = pcb.rules;
        sectionLines.push(`rules clearance=${fmtMm(r.clearance)} track=${fmtMm(r.track)} via=${fmtMm(r.via)} drill=${fmtMm(r.drill)}`);
      }
      const effRules = pcb.rules ?? DEFAULT_PCB_RULES;
      for (const net of q.nets()) {
        for (const t of pcb.tracks) {
          if (t.net !== net.id) continue;
          const pts = t.points.map(([x, y]) => `${fmtMm(x)},${fmtMm(y)}`).join(' ');
          sectionLines.push(`track ${net.name} ${t.layer} ${fmtMm(t.width)} ${pts}`);
        }
        for (const v of pcb.vias) {
          if (v.net !== net.id) continue;
          const custom = v.size !== effRules.via || v.drill !== effRules.drill;
          const tail = custom ? ` size=${fmtMm(v.size)} drill=${fmtMm(v.drill)}` : '';
          sectionLines.push(`via ${net.name} ${fmtMm(v.at[0])},${fmtMm(v.at[1])}${tail}`);
        }
      }
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
