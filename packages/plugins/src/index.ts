// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CadError, errorText, type PartDef, type Query } from '@cadllm/core';
import { validatePart } from '@cadllm/library';
import {
  validateManifest,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PluginIssue,
  type PluginManifest,
  type PluginPermission,
  type ProjectEditOptions,
  type ProjectReadOptions,
} from '@cadllm/plugin-api';

/** Absolute path to the preloaded JS network isolation guard (`--import <NETWORK_GUARD_PATH>`). */
export const NETWORK_GUARD_PATH = resolve(import.meta.dirname, 'guard.mjs');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_CRASH_RESTARTS = 3;
const DEFAULT_CRASH_BACKOFF_MS = 50;
const MAX_STDERR_BYTES = 8192;

function findPkgDir(filePath: string): string {
  let dir = dirname(filePath);
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return dirname(filePath);
    dir = parent;
  }
  return dir;
}

const req = createRequire(import.meta.url);
const PLUGIN_API_ENTRY = realpathSync(req.resolve('@cadllm/plugin-api'));
const PLUGIN_API_DIR = findPkgDir(PLUGIN_API_ENTRY);
const ZOD_DIR = dirname(realpathSync(createRequire(PLUGIN_API_ENTRY).resolve('zod/package.json')));

export interface SandboxArgsOptions {
  /** Plugin root directory granted `--allow-fs-read`. */
  pluginDir?: string;
  /** Additional bootstrap/runtime files granted `--allow-fs-read`. */
  bootstrapFiles?: readonly string[];
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function resolveGrantPath(raw: string, pluginDir?: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') {
    throw new CadError('invalid', `unsafe fs permission path "${raw}"`);
  }
  return pluginDir ? resolve(pluginDir, trimmed) : resolve(trimmed);
}

/**
 * Compute Node 24 CLI flags (`--permission`, `--allow-fs-read=...`, `--import`, etc.)
 * for spawning a sandboxed plugin child process.
 */
export function sandboxArgs(
  manifest: PluginManifest,
  grants: readonly PluginPermission[] = [],
  opts: SandboxArgsOptions = {},
): string[] {
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const pluginDir = opts.pluginDir ? resolve(opts.pluginDir) : undefined;

  if (pluginDir) addUnique(readPaths, pluginDir);
  addUnique(readPaths, NETWORK_GUARD_PATH);
  addUnique(readPaths, PLUGIN_API_DIR);
  addUnique(readPaths, ZOD_DIR);
  for (const f of opts.bootstrapFiles ?? []) {
    if (f.trim()) addUnique(readPaths, resolve(f));
  }

  const requested = new Set(manifest.permissions);
  for (const perm of grants) {
    if (!requested.has(perm)) continue;
    if (perm.startsWith('fs:read:')) {
      addUnique(readPaths, resolveGrantPath(perm.slice(8), pluginDir));
    } else if (perm.startsWith('fs:write:')) {
      addUnique(writePaths, resolveGrantPath(perm.slice(9), pluginDir));
    }
  }

  const args: string[] = ['--permission'];
  for (const p of readPaths) args.push(`--allow-fs-read=${p}`);
  for (const p of writePaths) args.push(`--allow-fs-write=${p}`);
  args.push('--import', pathToFileURL(NETWORK_GUARD_PATH).href);
  return args;
}

export type PluginStatus = 'loaded' | 'running' | 'failed';

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  grants: PluginPermission[];
  status?: PluginStatus;
  error?: string;
}

export interface PluginToolInfo {
  name: string;
  summary: string;
  pluginId: string;
  version: string;
  inputSchema?: Record<string, unknown>;
}

export interface PluginCheckIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
  at: string[];
  pluginId: string;
}

export interface PluginPanelInfo {
  id: string;
  title: string;
  pluginId: string;
  version: string;
  main: string;
  dir: string;
}

export interface PluginRpcContext {
  readProject?(opts?: ProjectReadOptions): string | Promise<string>;
  editProject?(cnl: string, opts?: ProjectEditOptions): string | Promise<string>;
  getPart?(id: string): PartDef | undefined | Promise<PartDef | undefined>;
  searchParts?(q: string, limit?: number): PartDef[] | Promise<PartDef[]>;
  onLog?(pluginId: string, level: 'info' | 'warn' | 'error', message: string): void;
}

export interface PluginHostOptions {
  /** Grants map `{ [pluginId]: PluginPermission[] }` or lookup callback. */
  grants?: Record<string, PluginPermission[]> | ((pluginId: string) => PluginPermission[]);
  /** Built-in part IDs so conflicting plugin part IDs are namespaced as `<pluginId>:<partId>`. */
  builtinPartIds?: ReadonlySet<string>;
  /** Per-call RPC timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Maximum stdout message size in bytes before killing a runaway child (default 1_048_576). */
  maxOutputBytes?: number;
  /** Consecutive crashes before marking a plugin `failed` (default 3). */
  maxCrashRestarts?: number;
  /** Base backoff delay in ms before restarting after repeated crashes (default 50). */
  crashBackoffMs?: number;
  /** Default RPC capability callbacks for `project.read`, `project.edit`, and `parts.get/search`. */
  context?: PluginRpcContext;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
  grants: PluginPermission[];
  parts: PartDef[];
  models: Map<string, string>;
  status: PluginStatus;
  error?: string;
  child?: ChildProcessWithoutNullStreams;
  startPromise?: Promise<void>;
  pending: Map<number, PendingRpc>;
  nextId: number;
  stderrBuf: string;
  consecutiveFailures: number;
  nextRestartAt: number;
  activeContext?: PluginRpcContext;
}

function isWithinDir(rootDir: string, targetPath: string): boolean {
  const rel = relative(rootDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveInsideDir(pluginDir: string, relPath: string, realRoot: string): string {
  const target = resolve(pluginDir, relPath);
  if (!isWithinDir(pluginDir, target)) {
    throw new CadError('invalid', `path "${relPath}" escapes plugin directory`);
  }
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (!isWithinDir(realRoot, realTarget)) {
      throw new CadError('invalid', `symlink "${relPath}" escapes plugin directory`);
    }
  }
  return target;
}

function collectJsonFiles(dir: string, realRoot: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      const real = realpathSync(full);
      if (!isWithinDir(realRoot, real)) {
        throw new CadError('invalid', `symlink "${full}" escapes plugin directory`);
      }
    }
    if (e.isDirectory()) out.push(...collectJsonFiles(full, realRoot));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function appendStderr(rec: PluginRecord, chunk: string): void {
  const tail = chunk.length > MAX_STDERR_BYTES ? chunk.slice(-MAX_STDERR_BYTES) : chunk;
  rec.stderrBuf = (rec.stderrBuf + tail).slice(-MAX_STDERR_BYTES);
}

function childEnv(allowedHosts: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const pathVal = process.env.PATH ?? process.env.Path;
  if (pathVal !== undefined) env.PATH = pathVal;
  const sysRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot;
  if (sysRoot !== undefined) env.SYSTEMROOT = sysRoot;
  if (allowedHosts.length > 0) env.CADLLM_ALLOWED_HOSTS = allowedHosts.join(',');
  return env;
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Host runtime managing loaded data and code plugins, child-process sandboxes, and capability RPC. */
export class PluginHost {
  readonly opts: PluginHostOptions;
  protected context: PluginRpcContext | undefined;
  protected builtinPartIds: ReadonlySet<string>;
  protected _revision = 0;
  #records = new Map<string, PluginRecord>();

  constructor(opts: PluginHostOptions = {}) {
    this.opts = opts;
    this.context = opts.context;
    this.builtinPartIds = opts.builtinPartIds ?? new Set();
  }

  /** Monotonic counter incremented whenever loaded plugins or contributed parts change. */
  get revision(): number {
    return this._revision;
  }

  protected bumpRevision(): void {
    this._revision += 1;
  }

  setContext(ctx: PluginRpcContext): void {
    this.context = ctx;
  }

  setBuiltinPartIds(ids: ReadonlySet<string>): void {
    this.builtinPartIds = ids;
    this.bumpRevision();
  }

  private resolveGrants(manifest: PluginManifest, override?: PluginPermission[]): PluginPermission[] {
    const raw = override
      ?? (typeof this.opts.grants === 'function' ? this.opts.grants(manifest.id) : this.opts.grants?.[manifest.id])
      ?? [];
    const requested = new Set(manifest.permissions);
    const out: PluginPermission[] = [];
    for (const g of raw) {
      if (requested.has(g) && !out.includes(g)) out.push(g);
    }
    return out.sort(compareIds);
  }

  load(dir: string, opts?: { grants?: PluginPermission[] }): LoadedPlugin {
    const pluginDir = resolve(dir);
    if (!existsSync(pluginDir)) {
      throw new CadError('invalid', `plugin directory not found: ${pluginDir}`);
    }
    const realRoot = realpathSync(pluginDir);
    const manifestPath = resolveInsideDir(pluginDir, 'plugin.json', realRoot);
    if (!existsSync(manifestPath)) {
      throw new CadError('invalid', `missing plugin.json in ${pluginDir}`);
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new CadError('invalid', `invalid plugin.json in ${pluginDir}: ${errorText(err)}`);
    }

    const manifest = validateManifest(rawManifest);
    const grants = this.resolveGrants(manifest, opts?.grants);

    const parts: PartDef[] = [];
    if (manifest.contributes.parts) {
      const partsDir = resolveInsideDir(pluginDir, manifest.contributes.parts, realRoot);
      if (!existsSync(partsDir)) {
        throw new CadError('invalid', `plugin ${manifest.id}: missing parts directory ${manifest.contributes.parts}`);
      }
      for (const file of collectJsonFiles(partsDir, realRoot)) {
        const rawPart: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const problems = validatePart(rawPart);
        if (problems.length) {
          throw new CadError('invalid', `plugin ${manifest.id} invalid part ${file}: ${problems.join('; ')}`);
        }
        parts.push(rawPart as PartDef);
      }
    }

    const models = new Map<string, string>();
    for (const m of manifest.contributes.models ?? []) {
      if (m.spice !== undefined && m.spice.trim().length > 0) {
        models.set(m.id, m.spice);
      } else {
        const rel = m.file ?? m.main;
        if (!rel) throw new CadError('invalid', `plugin ${manifest.id}: spice model ${m.id} missing file`);
        const modelPath = resolveInsideDir(pluginDir, rel, realRoot);
        if (!existsSync(modelPath)) {
          throw new CadError('invalid', `plugin ${manifest.id}: missing spice model file ${rel}`);
        }
        models.set(m.id, readFileSync(modelPath, 'utf8'));
      }
    }

    if (manifest.main) {
      resolveInsideDir(pluginDir, manifest.main, realRoot);
    }
    for (const panel of manifest.contributes.panels ?? []) {
      resolveInsideDir(pluginDir, panel.main, realRoot);
    }

    const prev = this.#records.get(manifest.id);
    if (prev) {
      this.terminateChild(prev, 'plugin reloaded');
      this.#records.delete(manifest.id);
    }

    const record: PluginRecord = {
      manifest,
      dir: pluginDir,
      grants,
      parts,
      models,
      status: 'loaded',
      pending: new Map(),
      nextId: 1,
      stderrBuf: '',
      consecutiveFailures: 0,
      nextRestartAt: 0,
    };

    this.#records.set(manifest.id, record);
    this.bumpRevision();
    return this.toLoadedPlugin(record);
  }

  unload(pluginId: string): boolean {
    const rec = this.#records.get(pluginId);
    if (!rec) return false;
    this.terminateChild(rec, `plugin ${pluginId} unloaded`);
    this.#records.delete(pluginId);
    this.bumpRevision();
    return true;
  }

  private toLoadedPlugin(rec: PluginRecord): LoadedPlugin {
    return {
      manifest: rec.manifest,
      dir: rec.dir,
      grants: [...rec.grants],
      status: rec.status,
      ...(rec.error !== undefined ? { error: rec.error } : {}),
    };
  }

  private orderedRecords(): PluginRecord[] {
    return [...this.#records.values()].sort((a, b) => compareIds(a.manifest.id, b.manifest.id));
  }

  list(): LoadedPlugin[] {
    return this.orderedRecords().map(r => this.toLoadedPlugin(r));
  }

  private resolvePartEntries(): Array<{ pluginId: string; rawId: string; part: PartDef }> {
    const claimed = new Set(this.builtinPartIds);
    const out: Array<{ pluginId: string; rawId: string; part: PartDef }> = [];
    for (const rec of this.orderedRecords()) {
      for (const p of rec.parts) {
        const finalPart = !claimed.has(p.id)
          ? p
          : { ...p, id: `${rec.manifest.id}:${p.id}` };
        claimed.add(finalPart.id);
        out.push({ pluginId: rec.manifest.id, rawId: p.id, part: finalPart });
      }
    }
    return out;
  }

  parts(): PartDef[] {
    return this.resolvePartEntries().map(e => e.part);
  }

  /** Aliases (`<pluginId>:<partId>` and `<pluginId>/<partId>`) for all loaded plugin parts. */
  partAliases(): Map<string, PartDef> {
    const aliases = new Map<string, PartDef>();
    for (const { pluginId, rawId, part } of this.resolvePartEntries()) {
      aliases.set(`${pluginId}:${rawId}`, part);
      aliases.set(`${pluginId}/${rawId}`, part);
    }
    return aliases;
  }

  spiceModels(): Map<string, string> {
    const out = new Map<string, string>();
    for (const rec of this.orderedRecords()) {
      for (const [id, text] of rec.models) {
        if (!out.has(id)) out.set(id, text);
      }
    }
    return out;
  }

  panels(): PluginPanelInfo[] {
    const out: PluginPanelInfo[] = [];
    for (const rec of this.orderedRecords()) {
      for (const p of rec.manifest.contributes.panels ?? []) {
        out.push({
          id: p.id,
          title: p.title,
          pluginId: rec.manifest.id,
          version: rec.manifest.version,
          main: p.main,
          dir: rec.dir,
        });
      }
    }
    return out;
  }

  private resolveToolTable(): {
    infos: PluginToolInfo[];
    lookup: Map<string, { rec: PluginRecord; rawName: string }>;
  } {
    const infos: PluginToolInfo[] = [];
    const lookup = new Map<string, { rec: PluginRecord; rawName: string }>();
    const claimedNames = new Set<string>();

    for (const rec of this.orderedRecords()) {
      for (const t of rec.manifest.contributes.tools ?? []) {
        const exposedName = claimedNames.has(t.name) ? `${rec.manifest.id}:${t.name}` : t.name;
        claimedNames.add(exposedName);
        infos.push({
          name: exposedName,
          summary: t.summary,
          pluginId: rec.manifest.id,
          version: rec.manifest.version,
          ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        });
        const entry = { rec, rawName: t.name };
        lookup.set(exposedName, entry);
        lookup.set(`${rec.manifest.id}:${t.name}`, entry);
        lookup.set(`${rec.manifest.id}/${t.name}`, entry);
      }
    }
    return { infos, lookup };
  }

  tools(): PluginToolInfo[] {
    return this.resolveToolTable().infos;
  }

  async callTool(name: string, args: Record<string, unknown> = {}, ctx?: PluginRpcContext): Promise<string> {
    const target = this.resolveToolTable().lookup.get(name);
    if (!target) {
      throw new CadError('invalid', `unknown plugin tool ${name}`, 'list tools with ext op=list');
    }
    const res = await this.invokePlugin(target.rec, 'tool/call', { name: target.rawName, args }, ctx);
    return typeof res === 'string' ? res : String(res);
  }

  async runChecks(_q: Query, ctx?: PluginRpcContext): Promise<PluginCheckIssue[]> {
    const all: PluginCheckIssue[] = [];
    for (const rec of this.orderedRecords()) {
      const checks = rec.manifest.contributes.checks;
      if (!checks || checks.length === 0) continue;
      const raw = await this.invokePlugin(rec, 'check/run', {}, ctx);
      if (!Array.isArray(raw)) continue;
      for (const item of raw as PluginIssue[]) {
        all.push({
          level: item.level === 'error' ? 'error' : 'warn',
          code: item.code ?? 'plugin_check',
          message: item.message,
          at: Array.isArray(item.at) ? item.at : [],
          pluginId: rec.manifest.id,
        });
      }
    }
    return all;
  }

  async dispose(): Promise<void> {
    const exits: Promise<void>[] = [];
    for (const rec of this.#records.values()) {
      const child = rec.child;
      this.terminateChild(rec, 'plugin host disposed');
      if (child && child.exitCode === null && child.signalCode === null) {
        exits.push(
          new Promise<void>(resolveExit => {
            const fallback = setTimeout(done, 1000);
            function done(): void {
              clearTimeout(fallback);
              resolveExit();
            }
            child.once('close', done);
          }),
        );
      }
    }
    this.#records.clear();
    this.bumpRevision();
    await Promise.all(exits);
  }

  private terminateChild(rec: PluginRecord, reason: string, countFailure = false): void {
    const child = rec.child;
    rec.child = undefined;
    rec.startPromise = undefined;

    for (const [id, pending] of rec.pending) {
      clearTimeout(pending.timer);
      rec.pending.delete(id);
      pending.reject(new CadError('invalid', reason));
    }

    if (child) {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore if already exited.
      }
    }

    if (countFailure) {
      this.recordFailure(rec, reason);
    } else if (rec.status === 'running') {
      rec.status = 'loaded';
    }
  }

  private recordFailure(rec: PluginRecord, reason: string): void {
    rec.consecutiveFailures += 1;
    const maxRestarts = this.opts.maxCrashRestarts ?? DEFAULT_MAX_CRASH_RESTARTS;
    const baseBackoff = this.opts.crashBackoffMs ?? DEFAULT_CRASH_BACKOFF_MS;

    if (rec.consecutiveFailures >= maxRestarts) {
      rec.status = 'failed';
      rec.error = reason;
      rec.nextRestartAt = Infinity;
    } else {
      rec.status = 'loaded';
      const delay = rec.consecutiveFailures <= 1 ? 0 : baseBackoff * Math.pow(2, rec.consecutiveFailures - 2);
      rec.nextRestartAt = Date.now() + delay;
    }
  }

  private async ensureStarted(rec: PluginRecord, ctx?: PluginRpcContext): Promise<void> {
    if (rec.status === 'failed') {
      throw new CadError('invalid', `plugin ${rec.manifest.id} failed: ${rec.error ?? 'crash limit exceeded'}`);
    }
    if (rec.child && rec.child.exitCode === null && rec.child.signalCode === null) {
      if (rec.startPromise) await rec.startPromise;
      return;
    }
    if (rec.startPromise) {
      await rec.startPromise;
      return;
    }

    const waitMs = rec.nextRestartAt - Date.now();
    if (waitMs > 0) {
      await new Promise<void>(resolveWait => setTimeout(resolveWait, waitMs));
    }
    if ((rec.status as PluginStatus) === 'failed') {
      throw new CadError('invalid', `plugin ${rec.manifest.id} failed: ${rec.error ?? 'crash limit exceeded'}`);
    }

    if (!rec.manifest.main) {
      throw new CadError('invalid', `plugin ${rec.manifest.id} has no "main" entry point`);
    }
    const realRoot = realpathSync(rec.dir);
    const entryPath = resolveInsideDir(rec.dir, rec.manifest.main, realRoot);
    if (!existsSync(entryPath)) {
      throw new CadError('invalid', `plugin ${rec.manifest.id}: missing entry file ${rec.manifest.main}`);
    }

    const allowedHosts = rec.grants
      .filter((g): g is `net:${string}` => g.startsWith('net:'))
      .map(g => g.slice(4).trim().toLowerCase())
      .filter(Boolean);

    const args = [...sandboxArgs(rec.manifest, rec.grants, { pluginDir: rec.dir }), entryPath];
    rec.stderrBuf = '';
    rec.activeContext = ctx ?? this.context;

    const child = spawn(process.execPath, args, {
      cwd: rec.dir,
      env: childEnv(allowedHosts),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rec.child = child;
    rec.status = 'running';

    const maxBytes = this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const failAndKill = (message: string): void => {
      if (rec.child !== child) return;
      this.terminateChild(rec, message, true);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      appendStderr(rec, chunk.toString('utf8'));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length) {
        if (rec.child !== child) return;
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1) {
          const segLen = chunk.length - start;
          if (lineBytes + segLen > maxBytes) {
            failAndKill(`plugin ${rec.manifest.id} exceeded max output limit (${maxBytes} bytes)`);
            return;
          }
          lineChunks.push(chunk.subarray(start));
          lineBytes += segLen;
          return;
        }
        const segLen = nl - start;
        if (lineBytes + segLen > maxBytes) {
          failAndKill(`plugin ${rec.manifest.id} exceeded max output limit (${maxBytes} bytes)`);
          return;
        }
        const lineBuf = lineChunks.length > 0
          ? Buffer.concat([...lineChunks, chunk.subarray(start, nl)], lineBytes + segLen)
          : chunk.subarray(start, nl);
        lineChunks = [];
        lineBytes = 0;
        start = nl + 1;
        this.handleStdoutLine(rec, child, lineBuf.toString('utf8'));
      }
    });

    child.on('error', err => {
      if (rec.child !== child) return;
      failAndKill(`plugin ${rec.manifest.id} process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (rec.child !== child) return;
      const tail = rec.stderrBuf.trim() ? `: ${rec.stderrBuf.trim().slice(-300)}` : '';
      const why = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      failAndKill(`plugin ${rec.manifest.id} exited unexpectedly (${why})${tail}`);
    });

    const activatePromise = this.sendRpc(rec, child, 'plugin/activate', {})
      .then(() => {
        rec.startPromise = undefined;
      })
      .catch(err => {
        rec.startPromise = undefined;
        throw err;
      });
    rec.startPromise = activatePromise;
    await activatePromise;
  }

  private handleStdoutLine(rec: PluginRecord, child: ChildProcessWithoutNullStreams, raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      rec.activeContext?.onLog?.(rec.manifest.id, 'warn', `non-JSON stdout from plugin: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;

    if (typeof msg.method === 'string') {
      void this.handlePluginCall(rec, child, msg as unknown as JsonRpcRequest);
      return;
    }

    if (typeof msg.id === 'number') {
      const entry = rec.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      rec.pending.delete(msg.id);
      const errObj = msg.error as JsonRpcFailure['error'] | undefined;
      if (errObj && typeof errObj === 'object') {
        entry.reject(new CadError('invalid', errObj.message || 'plugin RPC error'));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private writeRpc(child: ChildProcessWithoutNullStreams, msg: JsonRpcRequest | JsonRpcResponse): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Ignore write error; exit handler will clean up.
    }
  }

  private async handlePluginCall(
    rec: PluginRecord,
    child: ChildProcessWithoutNullStreams,
    reqMsg: JsonRpcRequest,
  ): Promise<void> {
    const { id, method, params } = reqMsg;
    const ctx = rec.activeContext ?? this.context;
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;

    if (method === 'log') {
      const level = p.level === 'warn' || p.level === 'error' ? p.level : 'info';
      const message = typeof p.message === 'string' ? p.message : String(p.message ?? '');
      ctx?.onLog?.(rec.manifest.id, level, message);
      return;
    }

    const replyError = (code: number, message: string): void => {
      if (id !== undefined && id !== null) {
        this.writeRpc(child, { jsonrpc: '2.0', id, error: { code, message } });
      }
    };

    const replyResult = (result: unknown): void => {
      if (id !== undefined && id !== null) {
        this.writeRpc(child, { jsonrpc: '2.0', id, result });
      }
    };

    try {
      switch (method) {
        case 'project/read': {
          if (!rec.grants.includes('project:read')) {
            replyError(-32001, 'permission denied: project:read');
            return;
          }
          if (!ctx?.readProject) {
            replyError(-32603, 'project.read capability is unavailable');
            return;
          }
          const out = await ctx.readProject(p as ProjectReadOptions);
          replyResult(out);
          return;
        }
        case 'project/edit': {
          if (!rec.grants.includes('project:write')) {
            replyError(-32001, 'permission denied: project:write');
            return;
          }
          if (typeof p.cnl !== 'string') {
            replyError(-32602, 'invalid params: cnl string required');
            return;
          }
          if (!ctx?.editProject) {
            replyError(-32603, 'project.edit capability is unavailable');
            return;
          }
          const editOpts: ProjectEditOptions = {
            ...(typeof p.dry_run === 'boolean' ? { dry_run: p.dry_run } : {}),
            ...(typeof p.if_rev === 'number' ? { if_rev: p.if_rev } : {}),
          };
          const out = await ctx.editProject(p.cnl, editOpts);
          replyResult(out);
          return;
        }
        case 'parts/get': {
          const partId = typeof p.id === 'string' ? p.id : '';
          const part = ctx?.getPart
            ? await ctx.getPart(partId)
            : this.parts().find(x => x.id === partId);
          replyResult(part);
          return;
        }
        case 'parts/search': {
          const q = typeof p.q === 'string' ? p.q : '';
          const limit = typeof p.limit === 'number' ? p.limit : undefined;
          const hits = ctx?.searchParts
            ? await ctx.searchParts(q, limit)
            : this.parts().filter(x => x.id.includes(q) || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, limit ?? 20);
          replyResult(hits);
          return;
        }
        default:
          replyError(-32601, `unknown method ${method}`);
      }
    } catch (err) {
      replyError(-32000, errorText(err));
    }
  }

  private sendRpc(
    rec: PluginRecord,
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = rec.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        if (!rec.pending.has(id)) return;
        const msg = `plugin ${rec.manifest.id} timed out after ${timeoutMs}ms`;
        if (rec.child === child) {
          this.terminateChild(rec, msg, true);
        } else {
          rec.pending.delete(id);
          rejectRpc(new CadError('invalid', msg));
        }
      }, timeoutMs);
      timer.unref();

      rec.pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
      this.writeRpc(child, { jsonrpc: '2.0', id, method, params });
    });
  }

  private async invokePlugin(
    rec: PluginRecord,
    method: string,
    params: unknown,
    ctx?: PluginRpcContext,
  ): Promise<unknown> {
    await this.ensureStarted(rec, ctx);
    const child = rec.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new CadError('invalid', `plugin ${rec.manifest.id} is not running`);
    }
    rec.activeContext = ctx ?? this.context;
    const res = await this.sendRpc(rec, child, method, params);
    rec.consecutiveFailures = 0;
    return res;
  }
}
