// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, Doc, REF_RE, type ChangeSource, type PartDef, type TxInfo } from '@cadllm/core';
import { printDelta } from '@cadllm/dsl';
import { createLibrary, type Library } from '@cadllm/library';
import type { PluginHost } from '@cadllm/plugins';

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

export interface WorkspaceLibrary extends Library {
  spiceModels(): ReadonlyMap<string, string>;
}

function createMergedLibrary(base: Library, getPlugins: () => PluginHost | undefined): WorkspaceLibrary {
  let cachedHost: PluginHost | undefined;
  let cachedRev = -1;
  let cachedLib: Library = base;
  let cachedAliases: Map<string, PartDef> | undefined;

  const ensureCurrent = (): void => {
    const plugins = getPlugins();
    if (!plugins) {
      cachedHost = undefined;
      cachedRev = -1;
      cachedLib = base;
      cachedAliases = undefined;
      return;
    }
    const rev = plugins.revision;
    if (plugins === cachedHost && rev === cachedRev) return;

    cachedHost = plugins;
    cachedRev = rev;
    const pluginParts = plugins.parts();
    if (!pluginParts.length) {
      cachedLib = base;
      cachedAliases = undefined;
      return;
    }

    const merged: PartDef[] = [...base.all()];
    const seen = new Set<string>(merged.map(p => p.id));
    const aliases = new Map<string, PartDef>();

    for (const p of pluginParts) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        merged.push(p);
      }
      aliases.set(p.id, p);
      aliases.set(p.id.toLowerCase(), p);
      if (p.id.includes(':')) {
        const slash = p.id.replace(':', '/');
        aliases.set(slash, p);
        aliases.set(slash.toLowerCase(), p);
      } else if (p.id.includes('/')) {
        const colon = p.id.replace('/', ':');
        aliases.set(colon, p);
        aliases.set(colon.toLowerCase(), p);
      }
    }
    for (const [alias, p] of plugins.partAliases()) {
      aliases.set(alias, p);
      aliases.set(alias.toLowerCase(), p);
    }

    cachedLib = createLibrary(merged);
    cachedAliases = aliases;
  };

  return {
    get(id: string): PartDef | undefined {
      ensureCurrent();
      if (!cachedAliases) return base.get(id);
      return cachedLib.get(id) ?? cachedLib.get(id.toLowerCase()) ?? cachedAliases.get(id) ?? cachedAliases.get(id.toLowerCase());
    },
    all(): PartDef[] {
      ensureCurrent();
      return cachedLib.all();
    },
    search(q: string, limit?: number): PartDef[] {
      ensureCurrent();
      return cachedLib.search(q, limit);
    },
    summaryLine(p: PartDef): string {
      return base.summaryLine(p);
    },
    spiceModels(): ReadonlyMap<string, string> {
      return getPlugins()?.spiceModels() ?? new Map();
    },
  };
}

/** Open projects shared by every client session (MCP, UI, CLI). Sessions are `Engine`s. */
export class Workspace {
  readonly baseLibrary: Library;
  readonly library: WorkspaceLibrary;
  private _plugins: PluginHost | undefined;
  /** Base directory for relative paths. */
  readonly root: string;
  private projects = new Map<string, Project>();
  private listeners = new Set<(e: WorkspaceEvent) => void>();

  constructor(opts: { library: Library; plugins?: PluginHost; root?: string }) {
    this.baseLibrary = opts.library;
    this.root = opts.root ?? process.cwd();
    if (opts.plugins) this.setPlugins(opts.plugins);
    this.library = createMergedLibrary(this.baseLibrary, () => this._plugins);
  }

  get plugins(): PluginHost | undefined {
    return this._plugins;
  }

  setPlugins(plugins: PluginHost | undefined): void {
    this._plugins = plugins;
    if (plugins) {
      plugins.setBuiltinPartIds(new Set(this.baseLibrary.all().map(p => p.id)));
    }
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
