// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { basicChecks, CadError, Doc, naturalCompare, type ChangeSource, type Delta, type PartDef, type TxInfo } from '@cadllm/core';
import { applyEdit, codeMetaKey, loadCircuit, printCircuit, printDelta, saveCnl, TESTS_META_KEY } from '@cadllm/dsl';
import { bom, excellon, fabZip, gerbers, kicadPcb, pickAndPlace } from '@cadllm/export';
import type { Library } from '@cadllm/library';
import { isPcbPart, route as routePcb } from '@cadllm/pcb';
import type { PluginHost, PluginRpcContext } from '@cadllm/plugins';
import { view, viewChecks, type RenderOptions } from '@cadllm/views';
import { help } from './help.ts';
import { parseTests, runAdhoc, runFileTests } from './sim.ts';
import { Workspace, type Project } from './workspace.ts';

export interface EngineOptions {
  /** Shared projects. Omit for a private workspace over `library`. */
  workspace?: Workspace;
  library?: Library;
  /** Optional plugin host providing contributed parts, SPICE models, tools, and checks. */
  plugins?: PluginHost;
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
    this.workspace = opts.workspace ?? new Workspace({
      library: opts.library!,
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
      ...(opts.root ? { root: opts.root } : {}),
    });
    if (opts.workspace && opts.plugins && !opts.workspace.plugins) {
      opts.workspace.setPlugins(opts.plugins);
    }
    this.source = opts.source ?? 'ai';
    if (this.workspace.plugins) {
      this.workspace.plugins.setContext(this.pluginRpcContext());
    }
  }

  get library(): Library {
    return this.workspace.library;
  }

  get plugins(): PluginHost | undefined {
    return this.workspace.plugins;
  }

  private pluginRpcContext(): PluginRpcContext {
    return {
      readProject: opts => this.read(opts),
      editProject: (cnl, opts) =>
        this.edit(
          {
            cnl,
            ...(opts?.dry_run ? { dry_run: true } : {}),
            ...(opts?.if_rev !== undefined ? { if_rev: opts.if_rev } : {}),
          },
          'plugin',
        ),
      getPart: id => this.library.get(id) ?? this.library.get(id.toLowerCase()),
      searchParts: (q, limit) => this.library.search(q, limit),
    };
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

  read(args: { select?: string; detail?: 0 | 1 | 2; since?: number; place?: boolean; tests?: boolean; code?: string } = {}): string {
    const p = this.current;
    const q = p.doc.read;
    if (args.code !== undefined) {
      const comp = q.requireComponent(args.code);
      const code = q.circuit.meta[codeMetaKey(comp.ref)];
      return code !== undefined ? `${this.tag(p)} [code ${comp.ref}]\n${code}` : `${this.tag(p)} ${comp.ref}: no code`;
    }
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

  edit(args: { cnl?: string; tests?: string; code?: { ref: string; text: string }; dry_run?: boolean; if_rev?: number }, sourceOverride?: ChangeSource): string {
    if (args.cnl === undefined && args.tests === undefined && args.code === undefined) {
      throw new CadError('invalid', 'edit needs cnl, tests or code');
    }
    if (args.tests !== undefined && args.tests.trim()) parseTests(args.tests);
    const p = this.current;
    const info = p.doc.transact(tx => {
      if (args.cnl !== undefined) applyEdit(tx, args.cnl);
      if (args.tests !== undefined) tx.setMeta(TESTS_META_KEY, args.tests.trim() ? args.tests.replace(/\s+$/, '') : null);
      if (args.code !== undefined) {
        const comp = tx.requireComponent(args.code.ref);
        const key = codeMetaKey(comp.ref);
        const normalized = args.code.text.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
        const prev = tx.circuit.meta[key];
        if (normalized.trim() === '') {
          tx.setMeta(key, null);
          if (prev !== undefined) tx.notes.push(`code -${comp.ref}`);
        } else {
          tx.setMeta(key, normalized);
          if (prev !== normalized) tx.notes.push(`code ${comp.ref}`);
        }
      }
    }, { source: sourceOverride ?? this.source, ...(args.dry_run ? { dryRun: true } : {}), ...(args.if_rev !== undefined ? { ifRev: args.if_rev } : {}) });
    const line = printDelta(info, p.doc.read);
    const dry = args.dry_run ? `dry ${line.replace(/rev=\d+/, `rev=${p.doc.rev} unchanged`)}` : line;
    return `${dry}${args.dry_run ? '' : this.issueTail(p, info.delta)}`;
  }

  /** New issues worth showing after an edit: all errors, warnings only for touched items. */
  private issueTail(p: Project, d: Delta): string {
    const touched = new Set([...d.added, ...d.changed, ...d.renamed.map(r => r[1]), ...d.netsAdded, ...d.netsChanged, ...d.pcbNets].map(s => s.toUpperCase()));
    const issues = allIssues(p);
    const shown = issues.filter(i => i.level === 'error' || i.at.some(a => touched.has(a.split('.')[0]!.toUpperCase())));
    const errs = issues.filter(i => i.level === 'error').length;
    const warns = issues.length - errs;
    if (!issues.length) return ' · 0 issues';
    const head = ` · ${errs ? `${errs} err ` : ''}${warns ? `${warns} warn` : ''}`.trimEnd();
    return shown.length ? `${head}: ${shown.slice(0, MAX_ISSUES).map(i => i.message).join('; ')}${shown.length > MAX_ISSUES ? ` … ${shown.length - MAX_ISSUES} more (check)` : ''}` : `${head} (check)`;
  }

  // ---- library ----

  find(args: { q?: string; id?: string; limit?: number } = {}): string {
    if (args.id !== undefined) {
      const ids = args.id.split(/[\s,]+/).filter(Boolean);
      if (!ids.length) throw new CadError('invalid', 'find needs q or id');
      return ids.map(id => {
        const p = this.library.get(id) ?? this.library.get(id.toLowerCase());
        if (!p) {
          const near = this.library.search(id, 3).map(x => x.id);
          throw new CadError('unknown_part', `unknown part ${id}`, near.length ? `did you mean ${near.join(' ')}?` : 'search with find');
        }
        return describePart(p);
      }).join('\n\n');
    }
    const q = args.q ?? '';
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
    const hits = this.library.search(q, limit + 1);
    if (!hits.length) {
      const cats = [...new Set(this.library.all().map(p => p.category))].sort().join(' ');
      return `no parts match "${q}" · categories: ${cats}`;
    }
    const lines = hits.slice(0, limit).map(p => this.library.summaryLine(p));
    if (hits.length > limit) lines.push(`… more (limit=${limit * 2})`);
    return lines.join('\n');
  }

  part(args: { id: string }): string {
    return this.find({ id: args.id });
  }

  // ---- views ----

  /** Auto-place unplaced (or all / the given) components in a view, or autoroute PCB nets (op=route). */
  layout(args: { view: string; op?: 'place' | 'route'; refs?: string; nets?: string; all?: boolean }): string {
    const p = this.current;
    if (args.op === 'route') {
      if (args.view !== 'pcb') throw new CadError('invalid', 'op=route is only supported for view=pcb');
      const nets = args.nets?.split(/[\s,]+/).filter(Boolean);
      const r = routePcb(p.doc.read, { ...(nets?.length ? { nets } : {}), ...(args.all ? { reroute: true } : {}) });
      const info = p.doc.transact(tx => {
        if (args.all) {
          if (nets?.length) for (const n of nets) tx.removePcbCopper(n);
          else tx.removePcbCopper();
        }
        const pcbData = tx.ensurePcb();
        pcbData.tracks.push(...r.tracks);
        pcbData.vias.push(...r.vias);
      }, { label: 'route pcb', source: this.source });
      const unrouted = r.unrouted.length ? ` · ${r.unrouted.length} unrouted: ${r.unrouted.join(' ')}` : '';
      const notes = r.notes.length ? ` · ${r.notes.join(' · ')}` : '';
      return `ok rev=${info.rev} routed ${r.tracks.length} tracks, ${r.vias.length} vias${unrouted}${notes}`;
    }
    const v = this.view(args.view);
    const refs = args.refs?.split(/[\s,]+/).filter(Boolean);
    const r = v.autoPlace(p.doc.read, { ...(refs ? { refs } : {}), ...(args.all ? { all: true } : {}) });
    const entries = Object.entries(r.place);
    const notes = r.notes.length ? ` · ${r.notes.join(' · ')}` : '';
    if (!entries.length) return `${this.tag(p)} nothing to place in ${v.id} (all placed; all=true re-places)${notes}`;
    const info = p.doc.transact(tx => {
      for (const [ref, place] of entries) tx.updateComponent(ref, { place: { [v.id]: place } });
    }, { label: `layout ${v.id}`, source: this.source });
    const issues = v.check(p.doc.read);
    const errs = issues.filter(i => i.level === 'error');
    const tail = issues.length
      ? ` · ${errs.length ? `${errs.length} err ` : ''}${issues.length - errs.length ? `${issues.length - errs.length} warn` : ''}`.trimEnd() + `: ${issues.slice(0, MAX_ISSUES).map(i => i.message).join('; ')}`
      : ' · 0 issues';
    return `ok rev=${info.rev} placed ${entries.length} in ${v.id}: ${entries.map(([ref, pl]) => `${ref}@${pl}`).join(' ')}${tail}`;
  }

  /** SVG of a view of the current project. */
  renderSvg(args: { view: string } & RenderOptions): string {
    const { view: id, ...opts } = args;
    return this.view(id).render(this.current.doc.read, opts);
  }

  /** One line describing what renderSvg draws (for the MCP render tool's text part). */
  renderSummary(viewId: string): string {
    const p = this.current;
    const v = this.view(viewId);
    const comps = p.doc.read.components();
    const isHidden = (partId: string): boolean => {
      const part = p.doc.read.parts.get(partId);
      if (!part) return false;
      if (part.views?.[v.id] === 'none') return true;
      return v.id === 'pcb' && !isPcbPart(part);
    };
    const placed = comps.filter(c => c.place[v.id] !== undefined && !isHidden(c.part));
    const hidden = comps.filter(c => isHidden(c.part)).length;
    const unplaced = comps.length - placed.length - hidden;
    return `${this.tag(p)} ${v.id}: ${placed.length} parts drawn${unplaced ? ` · ${unplaced} unplaced (layout view=${v.id})` : ''}`;
  }

  private view(id: string) {
    try {
      return view(id);
    } catch {
      throw new CadError('invalid', `unknown view ${id}`, 'views: sch bb pcb');
    }
  }

  // ---- export ----

  export(args: { format: 'gerber' | 'drill' | 'fab' | 'kicad' | 'bom' | 'pnp' | 'svg'; view?: 'sch' | 'bb' | 'pcb'; path?: string }): string {
    const p = this.current;
    const q = p.doc.read;
    const baseDir = p.path ? dirname(p.path) : this.root;

    const resolveOutDir = (): string => {
      if (!args.path) return resolve(baseDir, `${p.name}-${args.format}`);
      return isAbsolute(args.path) ? args.path : resolve(baseDir, args.path);
    };

    const resolveOutFile = (defaultName: string): string => {
      if (!args.path) return resolve(baseDir, defaultName);
      const full = isAbsolute(args.path) ? args.path : resolve(baseDir, args.path);
      if (
        args.path.endsWith('/')
        || args.path.endsWith('\\')
        || (existsSync(full) && statSync(full).isDirectory())
        || extname(full).toLowerCase() !== extname(defaultName).toLowerCase()
      ) {
        return resolve(full, defaultName);
      }
      return full;
    };

    const pcbParts = q.components().filter(c => {
      const pt = q.parts.get(c.part);
      return pt !== undefined && isPcbPart(pt);
    });
    const placedParts = pcbParts.filter(c => c.place.pcb !== undefined);
    const padCount = placedParts.reduce((n, c) => n + (q.parts.get(c.part)?.pins.length ?? 0), 0);
    const trackCount = q.circuit.pcb?.tracks.length ?? 0;
    const viaCount = q.circuit.pcb?.vias.length ?? 0;
    const statsTail = `${padCount} ${padCount === 1 ? 'pad' : 'pads'} ${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} ${viaCount} ${viaCount === 1 ? 'via' : 'vias'}`;

    if (args.format === 'gerber' || args.format === 'drill') {
      const files = args.format === 'gerber' ? gerbers(q) : excellon(q);
      const dir = resolveOutDir();
      mkdirSync(dir, { recursive: true });
      const paths: string[] = [];
      for (const [name, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
        const out = resolve(dir, name);
        writeFileSync(out, content, 'utf8');
        paths.push(out);
      }
      const kindLabel = args.format === 'gerber' ? `${paths.length} gerbers` : `${paths.length} drill`;
      return `${paths.join('\n')}\nok ${args.format} ${dir} · ${kindLabel} · ${statsTail}`;
    }

    let defaultName: string;
    let data: string | Uint8Array;
    let summary: string;
    switch (args.format) {
      case 'fab':
        defaultName = `${p.name}-fab.zip`;
        data = fabZip(q);
        summary = `7 gerbers 2 drill · ${statsTail}`;
        break;
      case 'kicad':
        defaultName = `${p.name}.kicad_pcb`;
        data = kicadPcb(q);
        summary = `${placedParts.length} ${placedParts.length === 1 ? 'part' : 'parts'} · ${statsTail}`;
        break;
      case 'bom': {
        defaultName = `${p.name}-bom.csv`;
        const csv = bom(q);
        data = csv;
        const rows = Math.max(0, csv.trim().split('\n').length - 1);
        summary = `${rows} ${rows === 1 ? 'group' : 'groups'} · ${pcbParts.length} ${pcbParts.length === 1 ? 'part' : 'parts'}`;
        break;
      }
      case 'pnp': {
        defaultName = `${p.name}-pnp.csv`;
        const csv = pickAndPlace(q);
        data = csv;
        const rows = Math.max(0, csv.trim().split('\n').length - 1);
        summary = `${rows} placed ${rows === 1 ? 'part' : 'parts'}`;
        break;
      }
      case 'svg': {
        const viewId = args.view ?? 'sch';
        defaultName = `${p.name}-${viewId}.svg`;
        data = this.renderSvg({ view: viewId });
        summary = `${Buffer.byteLength(data, 'utf8')} bytes`;
        break;
      }
    }

    const out = resolveOutFile(defaultName);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
    if (args.format === 'svg') {
      return `${out}\nok exported svg ${out} (${summary})`;
    }
    return `${out}\nok ${args.format} ${out} · ${summary}`;
  }

  // ---- check / sim / ext ----

  async check(): Promise<string> {
    const p = this.current;
    const pluginIssues = this.plugins ? await this.plugins.runChecks(p.doc.read, this.pluginRpcContext()) : [];
    const issues = [
      ...allIssues(p),
      ...pluginIssues.map(i => ({
        level: i.level,
        message: i.message.includes(i.pluginId) ? i.message : `[${i.pluginId}] ${i.message}`,
      })),
    ];
    const errs = issues.filter(i => i.level === 'error');
    const head = `${this.tag(p)} ${errs.length} err ${issues.length - errs.length} warn`;
    return [head, ...issues.map(formatIssue)].join('\n');
  }

  async ext(args: { op: 'list' | 'call' | string; name?: string; args?: Record<string, unknown> }): Promise<string> {
    switch (args.op) {
      case 'list': {
        const tools = [...(this.plugins?.tools() ?? [])].sort((a, b) => naturalCompare(a.name, b.name));
        if (!tools.length) return 'no plugin tools installed';
        return tools.map(t => `${t.name}  ${t.summary}  (${t.pluginId}@${t.version})`).join('\n');
      }
      case 'call': {
        if (!args.name) throw new CadError('invalid', 'ext call needs name', 'list tools with ext op=list');
        if (!this.plugins) throw new CadError('invalid', `unknown plugin tool ${args.name}`, 'list tools with ext op=list');
        return this.plugins.callTool(args.name, args.args ?? {}, this.pluginRpcContext());
      }
      default:
        throw new CadError('invalid', `unknown ext op ${args.op}`, 'list call');
    }
  }

  async sim(args: { run: string }): Promise<string> {
    const p = this.current;
    const run = args.run.trim();
    const m = run.match(/^test(?:\s+(.+))?$/s);
    if (m) {
      const pattern = (m[1] ?? '*').trim().replace(/^"(.*)"$/, '$1');
      const r = await runFileTests(p.doc.read, p.doc.read.circuit.meta[TESTS_META_KEY], pattern);
      return `${this.tag(p)} ${r.text}`;
    }
    return `${this.tag(p)} ${await runAdhoc(p.doc.read, run)}`;
  }

  /** For the CLI: run tests of the current project. */
  async test(pattern = '*'): Promise<{ text: string; passed: number; failed: number }> {
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

function allIssues(p: Project) {
  const q = p.doc.read;
  return [...basicChecks(q), ...viewChecks(q)];
}

function formatIssue(i: { level: string; message: string }): string {
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
