// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, Doc, REF_RE, type ChangeSource, type TxInfo } from '@cadllm/core';
import { printDelta } from '@cadllm/dsl';
import type { Library } from '@cadllm/library';

export interface LogEntry {
  rev: number;
  source: ChangeSource;
  label?: string;
  summary: string;
}

export interface Project {
  name: string;
  doc: Doc;
  path?: string;
  parent?: { name: string; rev: number };
  log: LogEntry[];
  savedRev: number;
}

export type WorkspaceEvent =
  | { type: 'change'; project: string; info: TxInfo }
  | { type: 'open' | 'close'; project: string };

const MAX_LOG = 50;

/** Open projects shared by every client session (MCP, UI, CLI). Sessions are `Engine`s. */
export class Workspace {
  readonly library: Library;
  /** Base directory for relative paths. */
  readonly root: string;
  private projects = new Map<string, Project>();
  private listeners = new Set<(e: WorkspaceEvent) => void>();

  constructor(opts: { library: Library; root?: string }) {
    this.library = opts.library;
    this.root = opts.root ?? process.cwd();
  }

  has(name: string): boolean {
    return this.projects.has(name);
  }

  names(): string[] {
    return [...this.projects.keys()];
  }

  all(): Project[] {
    return [...this.projects.values()];
  }

  get(name: string): Project {
    const p = this.projects.get(name);
    if (!p) throw new CadError('invalid', `no open project ${name}`, `open: ${this.names().join(' ') || 'none'}`);
    return p;
  }

  create(name: string, doc = new Doc(this.library), extra: Partial<Omit<Project, 'name' | 'doc'>> = {}): Project {
    if (!REF_RE.test(name.replace(/[-.]/g, '_'))) throw new CadError('invalid_name', `bad project name ${name}`, 'letters, digits, - _ .');
    if (this.projects.has(name)) throw new CadError('invalid_name', `project ${name} is already open`, `project op=use name=${name}`);
    const p: Project = { name, doc, log: [], savedRev: 0, ...extra };
    doc.on(info => {
      p.log.push({ rev: info.rev, source: info.source, ...(info.label ? { label: info.label } : {}), summary: printDelta(info, doc.read).replace(/^ok rev=\d+ ?/, '') });
      if (p.log.length > MAX_LOG) p.log.shift();
      this.emit({ type: 'change', project: p.name, info });
    });
    this.projects.set(name, p);
    this.emit({ type: 'open', project: name });
    return p;
  }

  close(name: string): Project {
    const p = this.get(name);
    this.projects.delete(name);
    this.emit({ type: 'close', project: name });
    return p;
  }

  freshName(base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z]/, 'p$&');
    if (!this.projects.has(clean)) return clean;
    for (let i = 2; ; i++) if (!this.projects.has(`${clean}${i}`)) return `${clean}${i}`;
  }

  on(listener: (e: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WorkspaceEvent): void {
    for (const l of this.listeners) l(e);
  }
}
