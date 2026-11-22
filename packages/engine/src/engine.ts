// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { basicChecks, CadError, Doc, naturalCompare, type ChangeSource, type Delta, type Issue, type PartDef, type TxInfo } from '@cadllm/core';
import { applyEdit, loadCircuit, printCircuit, printDelta, saveCnl, TESTS_META_KEY } from '@cadllm/dsl';
import type { Library } from '@cadllm/library';
import { help } from './help.ts';
import { parseTests, runAdhoc, runFileTests } from './sim.ts';
import { Workspace, type Project } from './workspace.ts';

export interface EngineOptions {
  /** Shared projects. Omit for a private workspace over `library`. */
  workspace?: Workspace;
  library?: Library;
  /** Base directory for relative paths of a private workspace. Defaults to process.cwd(). */
  root?: string;
  /** Attribution for edits made through this session. */
  source?: ChangeSource;
}

const MAX_ISSUES = 8;
const MAX_LOG = 50;

/**
 * One client session (an MCP connection, a UI tab, the CLI) over a shared Workspace: its own current
 * project and edit attribution. Text in, text out; methods throw CadError(s) on bad input.
 */
export class Engine {
  readonly workspace: Workspace;
  readonly source: ChangeSource;
  private currentName: string | undefined;

  constructor(opts: EngineOptions) {
    if (!opts.workspace && !opts.library) throw new Error('Engine needs a workspace or a library');
    this.workspace = opts.workspace ?? new Workspace({ library: opts.library!, ...(opts.root ? { root: opts.root } : {}) });
    this.source = opts.source ?? 'ai';
  }

  get library(): Library {
    return this.workspace.library;
  }

  get root(): string {
    return this.workspace.root;
  }

  /** Name of this session's current project (created as "untitled" on first use). */
  get projectName(): string {
    return this.current.name;
  }

  /** The current project's document, for structured access (UI state, rendering). */
  get doc(): Doc {
    return this.current.doc;
  }

  private get current(): Project {
    if (this.currentName !== undefined && !this.workspace.has(this.currentName)) {
      const gone = this.currentName;
      this.currentName = undefined;
      throw new CadError('invalid', `project ${gone} was closed by another client`, `open: ${this.workspace.names().join(' ') || 'none'} · project op=use name=…`);
    }
    if (this.currentName === undefined) {
      this.currentName = this.workspace.has('untitled') ? 'untitled' : this.create('untitled').name;
    }
    return this.workspace.get(this.currentName);
  }

  private get(name: string): Project {
    return this.workspace.get(name);
  }

  private create(name: string, doc?: Doc, extra: Partial<Omit<Project, 'name' | 'doc'>> = {}): Project {
    const p = this.workspace.create(name, doc, extra);
    this.currentName = name;
    return p;
  }

  private freshName(base: string): string {
    return this.workspace.freshName(base);
  }

  private path(p: string): string {
    const full = isAbsolute(p) ? p : resolve(this.root, p);
    return extname(full) ? full : `${full}.cnl`;
  }

  private tag(p: Project): string {
    return `${p.name} rev=${p.doc.rev}`;
  }

  // ---- project ----

  project(args: { op: string; name?: string; path?: string }): string {
    switch (args.op) {
      case 'new': {
        const p = this.create(args.name ?? this.freshName('untitled'));
        return `ok project=${this.tag(p)}`;
      }
      case 'open': {
        if (!args.path) throw new CadError('invalid', 'open needs path');
        const file = this.path(args.path);
        if (!existsSync(file)) throw new CadError('invalid', `no file ${file}`);
        const doc = loadCircuit(readFileSync(file, 'utf8'), this.library);
        const p = this.create(args.name ?? this.freshName(basename(file, extname(file))), doc, { path: file });
        const tests = parseTests(doc.read.circuit.meta[TESTS_META_KEY] ?? '').length;
        return `ok project=${this.tag(p)} · ${printCircuit(doc.read, { detail: 0 })}${tests ? ` · ${tests} tests` : ''}`;
      }
      case 'save': {
        const p = args.name ? this.get(args.name) : this.current;
        if (args.path) p.path = this.path(args.path);
        p.path ??= resolve(this.root, `${p.name}.cnl`);
        writeFileSync(p.path, saveCnl(p.doc));
        p.savedRev = p.doc.rev;
        return `ok saved ${p.path} ${this.tag(p)}`;
      }
      case 'list': {
        if (!this.workspace.names().length) return 'no projects (edit creates "untitled")';
        return this.workspace.all().map(p => {
          const mark = p.name === this.currentName ? '*' : ' ';
          const from = p.parent ? ` fork of ${p.parent.name}@${p.parent.rev}` : '';
          const dirty = p.doc.rev !== p.savedRev ? ' unsaved' : '';
          return `${mark} ${this.tag(p)}${from}${dirty}${p.path ? ` ${p.path}` : ''}`;
        }).join('\n');
      }
      case 'use': {
        const p = this.get(this.need(args.name, 'use'));
        this.currentName = p.name;
        return `ok project=${this.tag(p)}`;
      }
      case 'fork': {
        const src = this.current;
        const doc = new Doc(this.library, src.doc.toJSON());
        const p = this.create(args.name ?? this.freshName(`${src.name}-fork`), doc, { parent: { name: src.name, rev: src.doc.rev } });
        return `ok project=${this.tag(p)} (from ${src.name}@${src.doc.rev})`;
      }
      case 'merge': {
        const fork = args.name ? this.get(args.name) : this.current;
        if (!fork.parent) throw new CadError('invalid', `${fork.name} is not a fork`);
        const parent = this.get(fork.parent.name);
        const note = parent.doc.rev !== fork.parent.rev ? ` · ${parent.name} changed since fork (rev ${fork.parent.rev}→${parent.doc.rev}); fork wins` : '';
        const info = parent.doc.replace(fork.doc.toJSON(), { label: `merge ${fork.name}`, source: this.source });
        this.workspace.close(fork.name);
        this.currentName = parent.name;
        return `${printDelta(info, parent.doc.read)} project=${parent.name} (merged ${fork.name})${note}`;
      }
      case 'close': {
        const p = args.name ? this.get(args.name) : this.current;
        this.workspace.close(p.name);
        if (this.currentName === p.name) this.currentName = this.workspace.names()[0];
        const warn = p.doc.rev !== p.savedRev ? ` (discarded unsaved rev=${p.doc.rev})` : '';
        return `ok closed ${p.name}${warn}${this.currentName ? ` · project=${this.currentName}` : ''}`;
      }
      default:
        throw new CadError('invalid', `unknown project op ${args.op}`, 'new open save list use fork merge close');
    }
  }

  private need(v: string | undefined, op: string): string {
    if (!v) throw new CadError('invalid', `${op} needs name`);
    return v;
  }

  // ---- read ----

  read(args: { select?: string; detail?: 0 | 1 | 2; since?: number; place?: boolean; tests?: boolean } = {}): string {
    const p = this.current;
    const q = p.doc.read;
    const select = args.select?.split(/[\s,]+/).filter(Boolean);
    if (args.since !== undefined) return this.readSince(p, args.since);
    const body = printCircuit(q, { detail: args.detail ?? 1, place: args.place ?? false, ...(select ? { select } : {}) });
    const out = [args.detail === 0 ? `${this.tag(p)} · ${body}` : `${this.tag(p)}${body ? `\n${body}` : ' (empty)'}`];
    if (select) {
      const known = new Set([...q.components().map(c => c.ref.toUpperCase()), ...q.nets().map(n => `NET:${n.name.toUpperCase()}`)]);
      const missing = select.filter(s => !known.has(s.toUpperCase()));
      if (missing.length) out.push(`not found: ${missing.join(' ')}`);
    }
    const tests = q.circuit.meta[TESTS_META_KEY];
    if (args.tests && tests) out.push(`[tests]\n${tests}`);
    return out.join('\n');
  }

  private readSince(p: Project, since: number): string {
    const d = p.doc.since(since);
    if (since === p.doc.rev) return `${this.tag(p)} no changes`;
    const summary = printDelta({ rev: p.doc.rev, source: this.source, delta: d, notes: [] }, p.doc.read).replace(/^ok /, '');
    const refs = [...d.added, ...d.changed, ...d.renamed.map(r => r[1])];
    const nets = [...d.netsAdded, ...d.netsChanged, ...d.netsRenamed.map(r => r[1])].map(n => `net:${n}`);
    const body = refs.length + nets.length ? printCircuit(p.doc.read, { select: [...new Set([...refs, ...nets])] }) : '';
    return `${p.name} ${summary} (since ${since})${body ? `\n${body}` : ''}`;
  }

  // ---- edit ----

  edit(args: { cnl?: string; tests?: string; dry_run?: boolean; if_rev?: number }): string {
    if (args.cnl === undefined && args.tests === undefined) throw new CadError('invalid', 'edit needs cnl or tests');
    if (args.tests !== undefined && args.tests.trim()) parseTests(args.tests);
    const p = this.current;
    const info = p.doc.transact(tx => {
      if (args.cnl !== undefined) applyEdit(tx, args.cnl);
      if (args.tests !== undefined) tx.setMeta(TESTS_META_KEY, args.tests.trim() ? args.tests.replace(/\s+$/, '') : null);
    }, { source: this.source, ...(args.dry_run ? { dryRun: true } : {}), ...(args.if_rev !== undefined ? { ifRev: args.if_rev } : {}) });
    const line = printDelta(info, p.doc.read);
    const dry = args.dry_run ? `dry ${line.replace(/rev=\d+/, `rev=${p.doc.rev} unchanged`)}` : line;
    return `${dry}${args.dry_run ? '' : this.issueTail(p, info.delta)}`;
  }

  /** New issues worth showing after an edit: all errors, warnings only for touched items. */
  private issueTail(p: Project, d: Delta): string {
    const touched = new Set([...d.added, ...d.changed, ...d.renamed.map(r => r[1]), ...d.netsAdded, ...d.netsChanged].map(s => s.toUpperCase()));
    const issues = basicChecks(p.doc.read);
    const shown = issues.filter(i => i.level === 'error' || i.at.some(a => touched.has(a.split('.')[0]!.toUpperCase())));
    const errs = issues.filter(i => i.level === 'error').length;
    const warns = issues.length - errs;
    if (!issues.length) return ' · 0 issues';
    const head = ` · ${errs ? `${errs} err ` : ''}${warns ? `${warns} warn` : ''}`.trimEnd();
    return shown.length ? `${head}: ${shown.slice(0, MAX_ISSUES).map(i => i.message).join('; ')}${shown.length > MAX_ISSUES ? ` … ${shown.length - MAX_ISSUES} more (check)` : ''}` : `${head} (check)`;
  }

  // ---- library ----

  find(args: { q: string; limit?: number }): string {
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
    const hits = this.library.search(args.q, limit + 1);
    if (!hits.length) {
      const cats = [...new Set(this.library.all().map(p => p.category))].sort().join(' ');
      return `no parts match "${args.q}" · categories: ${cats}`;
    }
    const lines = hits.slice(0, limit).map(p => this.library.summaryLine(p));
    if (hits.length > limit) lines.push(`… more (limit=${limit * 2})`);
    return lines.join('\n');
  }

  part(args: { id: string }): string {
    return args.id.split(/[\s,]+/).filter(Boolean).map(id => {
      const p = this.library.get(id) ?? this.library.get(id.toLowerCase());
      if (!p) {
        const near = this.library.search(id, 3).map(x => x.id);
        throw new CadError('unknown_part', `unknown part ${id}`, near.length ? `did you mean ${near.join(' ')}?` : 'search with find');
      }
      return describePart(p);
    }).join('\n\n');
  }

  // ---- check / sim ----

  check(): string {
    const p = this.current;
    const issues = basicChecks(p.doc.read);
    const errs = issues.filter(i => i.level === 'error');
    const head = `${this.tag(p)} ${errs.length} err ${issues.length - errs.length} warn`;
    return [head, ...issues.map(formatIssue)].join('\n');
  }

  sim(args: { run: string }): string {
    const p = this.current;
    const run = args.run.trim();
    const m = run.match(/^test(?:\s+(.+))?$/s);
    if (m) {
      const pattern = (m[1] ?? '*').trim().replace(/^"(.*)"$/, '$1');
      return `${this.tag(p)} ${runFileTests(p.doc.read, p.doc.read.circuit.meta[TESTS_META_KEY], pattern).text}`;
    }
    return `${this.tag(p)} ${runAdhoc(p.doc.read, run)}`;
  }

  /** For the CLI: run tests of the current project. */
  test(pattern = '*'): { text: string; passed: number; failed: number } {
    const q = this.current.doc.read;
    return runFileTests(q, q.circuit.meta[TESTS_META_KEY], pattern);
  }

  // ---- history / help ----

  history(args: { op: string; n?: number }): string {
    const p = this.current;
    switch (args.op) {
      case 'undo':
      case 'redo': {
        const info: TxInfo | undefined = args.op === 'undo' ? p.doc.undo(this.source) : p.doc.redo(this.source);
        if (!info) return `nothing to ${args.op} (${this.tag(p)})`;
        return printDelta(info, p.doc.read);
      }
      case 'log': {
        const n = Math.min(Math.max(args.n ?? 5, 1), MAX_LOG);
        const rows = p.log.slice(-n).reverse().map(e => `rev ${e.rev} ${e.source}${e.label ? ` ${e.label}` : ''}: ${e.summary || '(meta)'}`);
        return rows.length ? `${this.tag(p)}\n${rows.join('\n')}` : `${this.tag(p)} no history`;
      }
      default:
        throw new CadError('invalid', `unknown history op ${args.op}`, 'undo redo log');
    }
  }

  help(args: { topic?: string } = {}): string {
    return help(args.topic, this.library);
  }
}

function formatIssue(i: Issue): string {
  return `${i.level === 'error' ? 'err ' : 'warn'} ${i.message}`;
}

const PIN_TYPE: Record<string, string> = {
  input: 'in', output: 'out', bidir: 'io', tristate: 'tri', power_in: 'pwr', power_out: 'src', open_collector: 'oc', nc: 'nc', passive: '',
};

/** One part, compact: summary, pins (id:name type), props, sim. */
export function describePart(p: PartDef): string {
  const lines = [`${p.id}  ${p.name} · ${p.summary} · ref ${p.refPrefix}`];
  const pins = p.pins.map(pin => {
    const t = PIN_TYPE[pin.type ?? 'passive'] ?? pin.type;
    const alias = pin.aliases?.length ? `(${pin.aliases.join('/')})` : '';
    return `${pin.id === pin.name ? pin.id : `${pin.id}:${pin.name}`}${alias}${t ? ` ${t}` : ''}`;
  });
  lines.push(`pins ${pins.join(' · ')}`);
  const props = Object.entries(p.props ?? {}).sort(([a], [b]) => naturalCompare(a, b)).map(([k, d]) => {
    const vals = d.options ? d.options.join('|') : d.type;
    return `${k}${k === p.valueProp ? '*' : ''}=${d.default ?? ''}${d.unit ? d.unit : ''} (${vals})`;
  });
  if (props.length) lines.push(`props ${props.join(' · ')}${p.valueProp ? '  (* = positional value)' : ''}`);
  if (p.sim?.length) lines.push(`sim ${p.sim.map(s => `${s.kind}:${s.ref}`).join(' ')}`);
  if (p.datasheet) lines.push(`datasheet ${p.datasheet}`);
  return lines.join('\n');
}
