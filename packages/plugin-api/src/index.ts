// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { createInterface } from 'node:readline';
import { z } from 'zod';

/** Public Plugin API version checked against `manifest.engine` semver ranges. */
export const PLUGIN_API_VERSION = '1.0.0-alpha.0';

// ---- Semver ----

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const NET_HOST_RE = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/;

export function parseSemver(version: string): Semver | undefined {
  const m = version.trim().match(SEMVER_RE);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    ...(m[4] !== undefined ? { prerelease: m[4] } : {}),
  };
}

function compareTuple(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined;
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined;
    if (na !== undefined && nb !== undefined) return na - nb;
    if (na !== undefined) return -1;
    if (nb !== undefined) return 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

function compareSemver(a: Semver, b: Semver, includePre: boolean): number {
  const t = compareTuple(a, b);
  if (t !== 0 || !includePre) return t;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function matchSingleComparator(comp: string, target: Semver): boolean | undefined {
  if (comp === '*' || comp === 'x' || comp === 'X') return true;

  const wild = comp.match(/^(\d+)(?:\.(?:x|X|\*))(?:\.(?:x|X|\*))?$/);
  if (wild) return target.major === Number(wild[1]);
  const wildMinor = comp.match(/^(\d+)\.(\d+)\.(?:x|X|\*)$/);
  if (wildMinor) return target.major === Number(wildMinor[1]) && target.minor === Number(wildMinor[2]);

  if (comp.startsWith('^')) {
    const base = parseSemver(comp.slice(1));
    if (!base) return undefined;
    const cmp = compareSemver(target, base, base.prerelease !== undefined);
    if (cmp < 0) return false;
    if (base.major > 0) return target.major === base.major;
    if (base.minor > 0) return target.major === 0 && target.minor === base.minor;
    return target.major === 0 && target.minor === 0 && target.patch === base.patch;
  }

  if (comp.startsWith('~')) {
    const base = parseSemver(comp.slice(1));
    if (!base) return undefined;
    const cmp = compareSemver(target, base, base.prerelease !== undefined);
    if (cmp < 0) return false;
    return target.major === base.major && target.minor === base.minor;
  }

  const opMatch = comp.match(/^(>=|<=|>|<|=)?(.+)$/);
  if (!opMatch) return undefined;
  const op = opMatch[1] ?? '=';
  const base = parseSemver(opMatch[2]!);
  if (!base) return undefined;
  const usePre = base.prerelease !== undefined || (op === '=' && comp.includes('-'));
  const cmp = compareSemver(target, base, usePre);
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=':
      if (base.prerelease !== undefined) return compareSemver(target, base, true) === 0;
      return compareTuple(target, base) === 0 && target.prerelease === undefined;
    default: return undefined;
  }
}

export function isValidSemverRange(range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;
  const dummy: Semver = { major: 1, minor: 0, patch: 0 };
  for (const alt of trimmed.split('||')) {
    const tokens = alt.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    for (const tok of tokens) {
      if (matchSingleComparator(tok, dummy) === undefined) return false;
    }
  }
  return true;
}

/** Check whether `engineVersion` (default `PLUGIN_API_VERSION`) satisfies a manifest `engine` range. */
export function satisfiesEngine(range: string, engineVersion = PLUGIN_API_VERSION): boolean {
  const target = parseSemver(engineVersion);
  if (!target) return false;
  const trimmed = range.trim();
  if (!trimmed) return false;
  for (const alt of trimmed.split('||')) {
    const tokens = alt.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    let allMatch = true;
    for (const tok of tokens) {
      const m = matchSingleComparator(tok, target);
      if (m === undefined) return false;
      if (!m) allMatch = false;
    }
    if (allMatch) return true;
  }
  return false;
}

// ---- Part & Check types (public boundary; structurally identical to @cadllm/core) ----

export type PinType =
  | 'passive' | 'input' | 'output' | 'bidir' | 'tristate'
  | 'power_in' | 'power_out' | 'open_collector' | 'nc';

export interface PinDef {
  id: string;
  name: string;
  aliases?: string[];
  type?: PinType;
}

export interface PropDef {
  type: 'number' | 'string' | 'enum' | 'bool';
  unit?: string;
  default?: string;
  options?: string[];
  description?: string;
}

export interface SimModelRef {
  kind: 'logic' | 'spice' | 'mcu';
  ref: string;
}

export interface PartDef {
  id: string;
  name: string;
  summary: string;
  category: string;
  refPrefix: string;
  pins: PinDef[];
  props?: Record<string, PropDef>;
  valueProp?: string;
  sim?: SimModelRef[];
  footprints?: string[];
  views?: { sch?: string; bb?: string; pcb?: string };
  keywords?: string[];
  datasheet?: string;
}

export interface PluginIssue {
  level: 'error' | 'warn';
  code?: string;
  message: string;
  at?: string[];
}

// ---- Permissions & Manifest Schema ----

export type PluginPermission =
  | 'project:read'
  | 'project:write'
  | `net:${string}`
  | `fs:read:${string}`
  | `fs:write:${string}`;

function isSafeRelativePath(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return false;
  }
  const segments = trimmed.split(/[/\\]+/);
  return !segments.some(s => s === '..');
}

export function isValidPermission(perm: string): perm is PluginPermission {
  if (perm === 'project:read' || perm === 'project:write') return true;
  if (perm.startsWith('net:')) {
    const host = perm.slice(4).trim();
    return host.length > 0 && NET_HOST_RE.test(host);
  }
  if (perm.startsWith('fs:read:')) return perm.slice(8).trim().length > 0;
  if (perm.startsWith('fs:write:')) return perm.slice(9).trim().length > 0;
  return false;
}

export const PermissionSchema = z.string().refine(isValidPermission, {
  message: 'invalid permission (expected project:read, project:write, net:<host>, fs:read:<path>, or fs:write:<path>)',
}) as z.ZodType<PluginPermission>;

export interface SpiceModelContribution {
  id: string;
  kind: 'spice';
  /** Relative path to a SPICE `.cir` / `.subckt` file inside the plugin directory. */
  file?: string;
  /** Alias for `file`. */
  main?: string;
  /** Inline SPICE `.subckt` / `.model` text. */
  spice?: string;
}

export const SpiceModelContributionSchema: z.ZodType<SpiceModelContribution> = z
  .object({
    id: z.string().trim().min(1, 'model id is required'),
    kind: z.string(),
    file: z.string().optional(),
    main: z.string().optional(),
    spice: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'digital') {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'JS digital models (kind: "digital") are deferred in M4 (cross-process call per logic event is too slow); only kind: "spice" is supported',
      });
      return;
    }
    if (val.kind !== 'spice') {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `unsupported model kind "${val.kind}"; only kind: "spice" is supported in M4`,
      });
      return;
    }
    const filePath = val.file ?? val.main;
    const hasFile = typeof filePath === 'string' && filePath.trim().length > 0;
    const hasSpice = typeof val.spice === 'string' && val.spice.trim().length > 0;
    if (!hasFile && !hasSpice) {
      ctx.addIssue({
        code: 'custom',
        message: `spice model "${val.id}" must specify "file" (or "main") or inline "spice" text`,
      });
    }
    if (val.file !== undefined && !isSafeRelativePath(val.file)) {
      ctx.addIssue({
        code: 'custom',
        path: ['file'],
        message: `model "${val.id}" file path "${val.file}" must be a relative path inside the plugin directory`,
      });
    }
    if (val.main !== undefined && !isSafeRelativePath(val.main)) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: `model "${val.id}" main path "${val.main}" must be a relative path inside the plugin directory`,
      });
    }
  }) as unknown as z.ZodType<SpiceModelContribution>;

export interface ToolContribution {
  name: string;
  summary: string;
  inputSchema?: Record<string, unknown>;
}

export const ToolContributionSchema: z.ZodType<ToolContribution> = z.object({
  name: z.string().regex(IDENT_RE, 'tool name must be an identifier (letters, digits, _, -)'),
  summary: z.string().trim().min(1, 'tool summary is required'),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

export interface CheckContribution {
  id: string;
  summary?: string;
}

export const CheckContributionSchema: z.ZodType<CheckContribution> = z.object({
  id: z.string().regex(IDENT_RE, 'check id must be an identifier (letters, digits, _, -)'),
  summary: z.string().trim().min(1).optional(),
});

export interface PanelContribution {
  id: string;
  title: string;
  main: string;
}

export const PanelContributionSchema: z.ZodType<PanelContribution> = z.object({
  id: z.string().regex(IDENT_RE, 'panel id must be an identifier (letters, digits, _, -)'),
  title: z.string().trim().min(1, 'panel title is required'),
  main: z.string().refine(isSafeRelativePath, 'panel main must be a relative path inside the plugin directory'),
});

export type ContributionKind = 'parts' | 'models' | 'tools' | 'checks' | 'panels';

export interface PluginContributes {
  parts?: string;
  models?: SpiceModelContribution[];
  tools?: ToolContribution[];
  checks?: CheckContribution[];
  panels?: PanelContribution[];
}

export const ContributesSchema: z.ZodType<PluginContributes> = z
  .object({
    parts: z
      .string()
      .refine(isSafeRelativePath, 'contributes.parts must be a relative path inside the plugin directory')
      .optional(),
    models: z.array(SpiceModelContributionSchema).optional(),
    tools: z.array(ToolContributionSchema).optional(),
    checks: z.array(CheckContributionSchema).optional(),
    panels: z.array(PanelContributionSchema).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const checkUnique = (items: readonly { id?: string; name?: string }[] | undefined, field: 'id' | 'name', label: string) => {
      if (!items) return;
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const key = items[i]?.[field];
        if (!key) continue;
        if (seen.has(key)) {
          ctx.addIssue({ code: 'custom', path: [label, i, field], message: `duplicate ${label} ${field} "${key}"` });
        }
        seen.add(key);
      }
    };
    checkUnique(c.models, 'id', 'models');
    checkUnique(c.tools, 'name', 'tools');
    checkUnique(c.checks, 'id', 'checks');
    checkUnique(c.panels, 'id', 'panels');
  });

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  summary?: string;
  publisher?: string;
  engine: string;
  license: string;
  main?: string;
  permissions: PluginPermission[];
  contributes: PluginContributes;
}

export const ManifestSchema: z.ZodType<PluginManifest> = z
  .object({
    id: z.string().regex(PLUGIN_ID_RE, 'plugin id must be 2..64 lowercase letters, digits, dots, hyphens, or underscores'),
    name: z.string().trim().min(1, 'plugin name is required'),
    version: z.string().refine(v => parseSemver(v) !== undefined, 'version must be valid semver (e.g. 1.0.0)'),
    summary: z.string().trim().min(1).optional(),
    publisher: z.string().trim().min(1).optional(),
    engine: z.string().refine(isValidSemverRange, 'engine must be a valid semver range (e.g. ^1.0.0)'),
    license: z.string().trim().min(1, 'license is required'),
    main: z
      .string()
      .refine(isSafeRelativePath, 'main must be a relative path inside the plugin directory')
      .optional(),
    permissions: z.array(PermissionSchema).default([]),
    contributes: ContributesSchema.default({}),
  })
  .strict();

/** Return a list of validation errors for `raw` (empty array when valid). */
export function checkManifest(raw: unknown, engineVersion = PLUGIN_API_VERSION): string[] {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map(i => {
      const path = i.path.length ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    });
  }
  const m = parsed.data;
  const errs: string[] = [];
  if (!satisfiesEngine(m.engine, engineVersion)) {
    errs.push(`engine: plugin requires engine "${m.engine}", current plugin-api is "${engineVersion}"`);
  }
  return errs;
}

/** Validate and parse a `plugin.json` manifest object, throwing an Error on invalid input or incompatible engine range. */
export function validateManifest(raw: unknown, engineVersion = PLUGIN_API_VERSION): PluginManifest {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
      .join('; ');
    throw new Error(`invalid plugin manifest: ${msg}`);
  }
  const manifest = parsed.data;
  if (!satisfiesEngine(manifest.engine, engineVersion)) {
    throw new Error(`incompatible plugin engine range "${manifest.engine}" for plugin-api "${engineVersion}"`);
  }
  return manifest;
}

/** Sorted list of contribution point kinds declared by a manifest. */
export function contributedKinds(manifest: PluginManifest): ContributionKind[] {
  const kinds: ContributionKind[] = [];
  const c = manifest.contributes;
  if (c.parts) kinds.push('parts');
  if (c.models?.length) kinds.push('models');
  if (c.tools?.length) kinds.push('tools');
  if (c.checks?.length) kinds.push('checks');
  if (c.panels?.length) kinds.push('panels');
  return kinds.sort();
}

// ---- Capability RPC Protocol Types (JSON-RPC 2.0 over newline-delimited stdio) ----

/** Methods invoked by the host on the plugin child process. */
export type HostToPluginMethod = 'plugin/activate' | 'tool/call' | 'check/run';

/** Methods invoked by the plugin child process on the host. */
export type PluginToHostMethod = 'project/read' | 'project/edit' | 'parts/get' | 'parts/search' | 'log';

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params?: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  method: M;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ---- Plugin-side Capability API & Helpers ----

export interface ProjectReadOptions {
  select?: string;
  detail?: 0 | 1 | 2;
  place?: boolean;
  tests?: boolean;
}

export interface ProjectEditOptions {
  dry_run?: boolean;
  if_rev?: number;
}

/** Capability API passed to plugin `activate`, `tools`, and `checks` handlers. */
export interface CadllmPluginApi {
  readonly project: {
    read(opts?: ProjectReadOptions): Promise<string>;
    edit(cnl: string, opts?: ProjectEditOptions): Promise<string>;
  };
  readonly parts: {
    get(id: string): Promise<PartDef | undefined>;
    search(q: string, limit?: number): Promise<PartDef[]>;
  };
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  cadllm: CadllmPluginApi,
) => string | Promise<string>;

export type CheckHandler = (
  cadllm: CadllmPluginApi,
) => PluginIssue[] | Promise<PluginIssue[]>;

export interface PluginDefinition {
  tools?: Record<string, ToolHandler>;
  checks?: Record<string, CheckHandler>;
  activate?: (cadllm: CadllmPluginApi) => void | Promise<void>;
}

let registeredPlugin: PluginDefinition | undefined;

/** Declare a CadLLM code plugin's tools, checks, and optional activate hook. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  registeredPlugin = def;
  return def;
}

export interface ConnectOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface PluginConnection {
  readonly api: CadllmPluginApi;
  close(): void;
}

/**
 * Connect a plugin definition to the host over newline-delimited JSON-RPC 2.0 on stdio.
 * Uses the plugin passed in `def` or the last plugin registered via `definePlugin(...)`.
 */
export function connect(def?: PluginDefinition, opts: ConnectOptions = {}): PluginConnection {
  const plugin = def ?? registeredPlugin ?? {};
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  let nextId = 1;
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const send = (msg: JsonRpcMessage): void => {
    output.write(`${JSON.stringify(msg)}\n`);
  };

  const request = <R>(method: PluginToHostMethod, params?: unknown): Promise<R> => {
    const id = nextId++;
    return new Promise<R>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  };

  const api: CadllmPluginApi = {
    project: {
      read: (readOpts?: ProjectReadOptions) => request<string>('project/read', readOpts ?? {}),
      edit: (cnl: string, editOpts?: ProjectEditOptions) => request<string>('project/edit', { cnl, ...(editOpts ?? {}) }),
    },
    parts: {
      get: (id: string) => request<PartDef | undefined>('parts/get', { id }),
      search: (q: string, limit?: number) => request<PartDef[]>('parts/search', { q, ...(limit !== undefined ? { limit } : {}) }),
    },
    log: (level, message) => {
      send({ jsonrpc: '2.0', method: 'log', params: { level, message } });
    },
  };

  const handleRequest = async (msg: JsonRpcRequest): Promise<void> => {
    const { id, method, params } = msg;
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    try {
      switch (method) {
        case 'plugin/activate': {
          if (plugin.activate) await plugin.activate(api);
          send({ jsonrpc: '2.0', id, result: { ok: true } });
          return;
        }
        case 'tool/call': {
          const name = typeof p.name === 'string' ? p.name : '';
          const args = (typeof p.args === 'object' && p.args !== null ? p.args : {}) as Record<string, unknown>;
          const handler = plugin.tools?.[name];
          if (!handler) {
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } });
            return;
          }
          const out = await handler(args, api);
          send({ jsonrpc: '2.0', id, result: typeof out === 'string' ? out : String(out) });
          return;
        }
        case 'check/run': {
          const checkId = typeof p.id === 'string' ? p.id : undefined;
          const issues: PluginIssue[] = [];
          if (checkId) {
            const handler = plugin.checks?.[checkId];
            if (!handler) {
              send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown check ${checkId}` } });
              return;
            }
            issues.push(...(await handler(api)));
          } else if (plugin.checks) {
            for (const [cid, handler] of Object.entries(plugin.checks)) {
              const res = await handler(api);
              for (const item of res) {
                issues.push({ code: item.code ?? cid, ...item });
              }
            }
          }
          send({ jsonrpc: '2.0', id, result: issues });
          return;
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      void handleRequest(msg as unknown as JsonRpcRequest);
    } else if (msg.id !== undefined && msg.id !== null) {
      const entry = pending.get(msg.id as number | string);
      if (!entry) return;
      pending.delete(msg.id as number | string);
      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as { message?: string };
        entry.reject(new Error(errObj.message ?? 'RPC error'));
      } else {
        entry.resolve(msg.result);
      }
    }
  });

  rl.on('close', () => {
    for (const [, req] of pending) req.reject(new Error('Plugin stdio closed'));
    pending.clear();
  });

  return {
    api,
    close() {
      rl.close();
    },
  };
}
