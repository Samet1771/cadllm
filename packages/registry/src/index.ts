// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contributedKinds,
  isValidPermission,
  parseSemver,
  PLUGIN_API_VERSION,
  satisfiesEngine,
  validateManifest,
  type ContributionKind,
  type PluginManifest,
  type PluginPermission,
  type Semver,
} from '@cadllm/plugin-api';
import { unzipSync, zipSync, type Zippable } from 'fflate';

/** Maximum allowed size in bytes for a `.cnlplugin` archive or extracted contents (20 MiB). */
export const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;

/** Fixed deterministic timestamp for all `.cnlplugin` zip entries (1980-01-01T00:00:00). */
const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/** Default repository `registry/` directory. */
const DEFAULT_REPO_REGISTRY_DIR = resolvePath(import.meta.dirname, '../../../registry');

/** Ed25519 ASN.1 DER prefixes for raw 32-byte keys. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Non-enumerable symbol holding the detached `index.sig` signature on a loaded `RegistryIndex`. */
const INDEX_SIG_SYMBOL = Symbol.for('cadllm.registry.indexSig');
/** Non-enumerable symbol indicating that an `index.sig` file was expected/checked on load. */
const HAS_INDEX_SIG_SYMBOL = Symbol.for('cadllm.registry.hasIndexSig');

export interface RegistryVersionEntry {
  id?: string;
  version: string;
  engine: string;
  url: string;
  sha256: string;
  size: number;
  permissions: PluginPermission[];
  contributes: ContributionKind[];
  signature: string;
}

export interface RegistryPluginEntry {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  license?: string;
  versions: RegistryVersionEntry[];
}

export interface RegistryKeysSection {
  publishers: Record<string, string>;
  signature: string;
  [publisher: string]: string | Record<string, string>;
}

export interface RegistryIndex {
  version: 1;
  keys: RegistryKeysSection;
  plugins: RegistryPluginEntry[];
  entries?: RegistryPluginEntry[];
  baseUrl?: string;
}

export interface ResolvedRegistryVersion {
  plugin: RegistryPluginEntry;
  version: RegistryVersionEntry;
  baseUrl?: string;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  dir: string;
  manifest: PluginManifest;
  grants: PluginPermission[];
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface InstallOptions {
  /** Override `~/.cadllm` state directory (also respects `CADLLM_STATE_DIR`). */
  stateDir?: string;
  /** Base URL or folder path for resolving relative `version.url`. */
  baseUrl?: string;
  /** Verified registry index used to look up the publisher public key. */
  index?: RegistryIndex;
  /** Explicit publisher ed25519 public key if `index` is not passed. */
  publisherPublicKey?: string;
  /** Trusted registry ed25519 public key. */
  registryPublicKey?: string;
  /** Permissions to grant (true = grant all declared permissions; array = grant subset). */
  grant?: PluginPermission[] | boolean;
  /** Interactive callback to approve requested permissions. */
  approvePermissions?: (permissions: PluginPermission[], manifest: PluginManifest) => boolean | Promise<boolean>;
  /** Engine semver version to check `version.engine` and `manifest.engine` against (default `PLUGIN_API_VERSION`). */
  engineVersion?: string;
  /** Maximum archive size in bytes (default `MAX_PLUGIN_BYTES` = 20 MiB). */
  maxBytes?: number;
  /** Network fetch timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export interface LoadIndexOptions {
  stateDir?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

interface CadllmConfig {
  registryUrl?: string;
  indexUrl?: string;
  registry?: string;
  registryKey?: string;
  registryPublicKey?: string;
}

export function resolveStateDir(override?: string): string {
  return override ?? process.env.CADLLM_STATE_DIR ?? join(homedir(), '.cadllm');
}

function readConfig(stateDir: string): CadllmConfig {
  const cfgPath = join(stateDir, 'config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as CadllmConfig;
    }
  } catch {
    // Ignore malformed config file and fall back to defaults.
  }
  return {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively sort object keys lexicographically for canonical JSON serialization. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      out[key] = canonicalize(v);
    }
  }
  return out;
}

/** Serialize `value` to canonical JSON (recursively sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Compute lowercase hex SHA-256 digest of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveKeyString(keyOrPath: string): string {
  const trimmed = keyOrPath.trim();
  if (!trimmed) throw new Error('empty key');
  if (trimmed.includes('-----BEGIN')) return trimmed;
  if (existsSync(trimmed) && statSync(trimmed).isFile()) {
    return readFileSync(trimmed, 'utf8').trim();
  }
  return trimmed;
}

function parsePublicKey(keyOrPath: string): KeyObject {
  const raw = resolveKeyString(keyOrPath);
  if (raw.includes('-----BEGIN')) {
    return createPublicKey(raw);
  }
  const cleanB64 = raw.replace(/\s+/g, '');
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length === 32) {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, buf]),
      format: 'der',
      type: 'spki',
    });
  }
  if (buf.length === 44) {
    return createPublicKey({ key: buf, format: 'der', type: 'spki' });
  }
  return createPublicKey(raw);
}

function parsePrivateKey(keyOrPath: string): KeyObject {
  const raw = resolveKeyString(keyOrPath);
  if (raw.includes('-----BEGIN')) {
    return createPrivateKey(raw);
  }
  const cleanB64 = raw.replace(/\s+/g, '');
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, buf]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  if (buf.length === 64) {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, buf.subarray(0, 32)]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  if (buf.length === 48) {
    return createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
  }
  return createPrivateKey(raw);
}

/** Derive an SPKI PEM public key from an Ed25519 private key PEM or base64 seed. */
export function derivePublicKeyPem(privateKeyOrPath: string): string {
  const priv = parsePrivateKey(privateKeyOrPath);
  const pub = createPublicKey(priv);
  return pub.export({ type: 'spki', format: 'pem' }).toString();
}

function payloadToBytes(entry: unknown): Buffer {
  if (entry instanceof Uint8Array) return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
  if (typeof entry === 'string') return Buffer.from(entry, 'utf8');
  if (isPlainObject(entry) && ('signature' in entry || 'baseUrl' in entry)) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'signature' || k === 'baseUrl') continue;
      copy[k] = v;
    }
    return Buffer.from(canonicalJson(copy), 'utf8');
  }
  return Buffer.from(canonicalJson(entry), 'utf8');
}

export function keygen(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function sign(entry: unknown, privateKey: string): string {
  const keyObj = parsePrivateKey(privateKey);
  const data = payloadToBytes(entry);
  return cryptoSign(null, data, keyObj).toString('base64');
}

function decodeSignatureBytes(signature: string): Buffer | undefined {
  if (typeof signature !== 'string') return undefined;
  const trimmed = signature.trim();
  if (!trimmed) return undefined;
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(trimmed) && !/^[A-Za-z0-9+/]{86}$/.test(trimmed)) {
    return undefined;
  }
  const padded = trimmed.endsWith('==') ? trimmed : `${trimmed}==`;
  const buf = Buffer.from(padded, 'base64');
  if (buf.length !== 64 || buf.toString('base64') !== padded) {
    return undefined;
  }
  return buf;
}

export function verifySignature(entry: unknown, signature: string, publicKey: string): boolean {
  const sigBuf = decodeSignatureBytes(signature);
  if (!sigBuf) return false;
  let keyObj: KeyObject;
  try {
    keyObj = parsePublicKey(publicKey);
  } catch {
    return false;
  }
  const data = payloadToBytes(entry);
  try {
    return cryptoVerify(null, data, keyObj, sigBuf);
  } catch {
    return false;
  }
}

async function fetchBytes(url: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const len = Number(contentLengthHeader);
      if (Number.isFinite(len) && len > opts.maxBytes) {
        throw new Error(`response from ${url} exceeds size limit (${len} > ${opts.maxBytes} bytes)`);
      }
    }
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > opts.maxBytes) {
        throw new Error(`response from ${url} exceeds size limit (${buf.byteLength} > ${opts.maxBytes} bytes)`);
      }
      return buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`response from ${url} exceeds size limit (${total} > ${opts.maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function attachIndexMetadata(
  index: RegistryIndex,
  baseUrl: string,
  indexSig: string | undefined,
  hasIndexSig: boolean,
): RegistryIndex {
  const raw = index as unknown as Record<string | symbol, unknown>;
  if (Array.isArray(raw.plugins) && Array.isArray(raw.entries)) {
    if (canonicalJson(raw.plugins) === canonicalJson(raw.entries)) {
      raw.entries = raw.plugins;
    }
  } else if (!('plugins' in raw) && Array.isArray(raw.entries)) {
    Object.defineProperty(index, 'plugins', {
      get() {
        return (this as { entries?: RegistryPluginEntry[] }).entries ?? [];
      },
      set(v: RegistryPluginEntry[]) {
        (this as { entries?: RegistryPluginEntry[] }).entries = v;
      },
      enumerable: false,
      configurable: true,
    });
  } else if (!('entries' in raw) && Array.isArray(raw.plugins)) {
    Object.defineProperty(index, 'entries', {
      get() {
        return (this as { plugins: RegistryPluginEntry[] }).plugins;
      },
      set(v: RegistryPluginEntry[]) {
        (this as { plugins: RegistryPluginEntry[] }).plugins = v;
      },
      enumerable: false,
      configurable: true,
    });
  }
  Object.defineProperty(index, 'baseUrl', {
    value: baseUrl,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(index, INDEX_SIG_SYMBOL, {
    value: indexSig,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(index, HAS_INDEX_SIG_SYMBOL, {
    value: hasIndexSig,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return index;
}

/** Attach or read the detached `index.sig` signature associated with an index object. */
export function getIndexSignature(index: RegistryIndex): string | undefined {
  return (index as unknown as Record<symbol, string | undefined>)[INDEX_SIG_SYMBOL];
}

export function setIndexSignature(index: RegistryIndex, sig: string): void {
  Object.defineProperty(index, INDEX_SIG_SYMBOL, {
    value: sig.trim(),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(index, HAS_INDEX_SIG_SYMBOL, {
    value: true,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export async function loadIndex(url?: string, opts: LoadIndexOptions = {}): Promise<RegistryIndex> {
  const stateDir = resolveStateDir(opts.stateDir);
  const config = readConfig(stateDir);
  const target = url?.trim() || config.registryUrl || config.indexUrl || config.registry || join(DEFAULT_REPO_REGISTRY_DIR, 'index.json');
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  let jsonText: string;
  let baseUrl: string;
  let indexSig: string | undefined;
  let hasIndexSig = false;

  if (target.startsWith('http://') || target.startsWith('https://')) {
    const parsedUrl = new URL(target);
    let indexUrl: string;
    let sigUrl: string;
    if (parsedUrl.pathname.endsWith('.json')) {
      indexUrl = parsedUrl.href;
      const basePath = parsedUrl.pathname.slice(0, parsedUrl.pathname.lastIndexOf('/') + 1);
      const baseObj = new URL(parsedUrl.href);
      baseObj.pathname = basePath;
      baseObj.search = '';
      baseObj.hash = '';
      baseUrl = baseObj.href;
      const sigObj = new URL(parsedUrl.href);
      sigObj.pathname = parsedUrl.pathname.replace(/\.json$/, '.sig');
      sigUrl = sigObj.href;
    } else {
      const normalized = target.endsWith('/') ? target : `${target}/`;
      baseUrl = normalized;
      indexUrl = new URL('index.json', normalized).href;
      sigUrl = new URL('index.sig', normalized).href;
    }

    const bytes = await fetchBytes(indexUrl, { maxBytes, timeoutMs: opts.timeoutMs });
    jsonText = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');

    try {
      const sigBytes = await fetchBytes(sigUrl, { maxBytes: 8192, timeoutMs: opts.timeoutMs });
      indexSig = Buffer.from(sigBytes.buffer, sigBytes.byteOffset, sigBytes.byteLength).toString('utf8').trim();
      hasIndexSig = true;
    } catch {
      // Optional if keys.signature is embedded in index.json; verifyIndex enforces signature presence.
    }
  } else {
    const localTarget = target.startsWith('file://') ? fileURLToPath(target) : resolvePath(target);
    if (!existsSync(localTarget)) {
      throw new Error(`registry index not found at ${localTarget}`);
    }
    const st = statSync(localTarget);
    const indexPath = st.isDirectory() ? join(localTarget, 'index.json') : localTarget;
    if (!existsSync(indexPath)) {
      throw new Error(`registry index not found at ${indexPath}`);
    }
    const indexStat = statSync(indexPath);
    if (indexStat.size > maxBytes) {
      throw new Error(`registry index exceeds size limit (${indexStat.size} > ${maxBytes} bytes)`);
    }
    baseUrl = dirname(indexPath);
    jsonText = readFileSync(indexPath, 'utf8');

    const candidateSigPaths = [
      join(baseUrl, 'index.sig'),
      indexPath.endsWith('.json') ? `${indexPath.slice(0, -5)}.sig` : `${indexPath}.sig`,
    ];
    for (const sp of candidateSigPaths) {
      if (existsSync(sp) && statSync(sp).isFile()) {
        indexSig = readFileSync(sp, 'utf8').trim();
        hasIndexSig = true;
        break;
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`invalid registry index JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('invalid registry index: root must be a JSON object');
  }

  return attachIndexMetadata(parsed as unknown as RegistryIndex, baseUrl, indexSig, hasIndexSig);
}

function getPublishersMap(index: RegistryIndex): Record<string, string> {
  if (!isPlainObject(index.keys)) {
    throw new Error('invalid registry index: missing "keys" object');
  }
  const keysObj = index.keys as Record<string, unknown>;
  if (isPlainObject(keysObj.publishers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(keysObj.publishers)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(keysObj)) {
    if (k === 'signature') continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function getPluginsList(index: RegistryIndex): RegistryPluginEntry[] {
  if (Array.isArray(index.plugins)) return index.plugins;
  if (Array.isArray(index.entries)) return index.entries;
  throw new Error('invalid registry index: missing "plugins" / "entries" array');
}

function resolveTrustedRegistryPublicKey(override?: string, stateDirOverride?: string): string {
  if (override && override.trim()) {
    return resolveKeyString(override);
  }
  const stateDir = resolveStateDir(stateDirOverride);
  const cfg = readConfig(stateDir);
  const configured = cfg.registryKey ?? cfg.registryPublicKey;
  if (configured && configured.trim()) {
    return resolveKeyString(configured);
  }
  const defaultPubPath = join(DEFAULT_REPO_REGISTRY_DIR, 'registry.pub');
  if (existsSync(defaultPubPath)) {
    return readFileSync(defaultPubPath, 'utf8').trim();
  }
  throw new Error('no trusted registry public key configured or found at registry/registry.pub');
}

function canonicalIndexWithoutBaseUrl(index: RegistryIndex): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(index as unknown as Record<string, unknown>)) {
    if (k === 'baseUrl') continue;
    out[k] = v;
  }
  return out;
}

function verifyVersionEntrySignature(
  v: RegistryVersionEntry,
  pluginId: string,
  publisherPublicKey: string,
): boolean {
  if (typeof v.signature !== 'string' || !v.signature.trim()) return false;
  if (v.id !== undefined && v.id !== pluginId) return false;
  if (verifySignature(v, v.signature, publisherPublicKey)) return true;
  if (verifySignature({ id: pluginId, ...v }, v.signature, publisherPublicKey)) return true;
  return false;
}

export function verifyIndex(
  index: RegistryIndex,
  registryPublicKey?: string,
  opts: { stateDir?: string } = {},
): boolean {
  if (!isPlainObject(index)) {
    throw new Error('invalid registry index: expected object');
  }
  const trustedRegPub = resolveTrustedRegistryPublicKey(registryPublicKey, opts.stateDir);
  // Ensure the trusted registry key is a valid parseable public key.
  try {
    parsePublicKey(trustedRegPub);
  } catch (err) {
    throw new Error(`invalid registry public key: ${err instanceof Error ? err.message : String(err)}`);
  }

  const publishers = getPublishersMap(index);
  const plugins = getPluginsList(index);

  const attachedSig = getIndexSignature(index);
  const hasAttachedSig = Boolean((index as unknown as Record<symbol, boolean | undefined>)[HAS_INDEX_SIG_SYMBOL]);
  const keysSig = isPlainObject(index.keys) && typeof index.keys.signature === 'string'
    ? index.keys.signature
    : undefined;
  const topLevelSig = typeof (index as unknown as { signature?: unknown }).signature === 'string'
    ? ((index as unknown as { signature: string }).signature)
    : undefined;

  let verifiedAnyRegistrySig = false;

  if (hasAttachedSig || attachedSig !== undefined) {
    if (!attachedSig || !verifySignature(canonicalIndexWithoutBaseUrl(index), attachedSig, trustedRegPub)) {
      throw new Error('registry index.sig signature verification failed');
    }
    verifiedAnyRegistrySig = true;
  }

  if (topLevelSig !== undefined) {
    const withoutTopSig = { ...canonicalIndexWithoutBaseUrl(index) };
    delete withoutTopSig.signature;
    if (!verifySignature(withoutTopSig, topLevelSig, trustedRegPub)) {
      throw new Error('registry index signature verification failed');
    }
    verifiedAnyRegistrySig = true;
  }

  if (keysSig !== undefined) {
    const keysPayloadValid =
      verifySignature({ publishers }, keysSig, trustedRegPub) ||
      verifySignature(
        {
          ...canonicalIndexWithoutBaseUrl(index),
          keys: { publishers },
        },
        keysSig,
        trustedRegPub,
      );
    if (!keysPayloadValid) {
      throw new Error('registry keys signature verification failed');
    }
    // Check that any top-level publisher keys in index.keys match index.keys.publishers.
    if (isPlainObject(index.keys.publishers)) {
      for (const [k, v] of Object.entries(index.keys)) {
        if (k === 'publishers' || k === 'signature') continue;
        if (index.keys.publishers[k] !== v) {
          throw new Error(`registry key mismatch for publisher "${k}"`);
        }
      }
    }
    verifiedAnyRegistrySig = true;
  }

  if (!verifiedAnyRegistrySig) {
    throw new Error('registry index is missing a registry signature (index.sig or keys.signature)');
  }

  for (const plugin of plugins) {
    if (!isPlainObject(plugin) || typeof plugin.id !== 'string' || !plugin.id.trim()) {
      throw new Error('invalid plugin entry in registry index: missing id');
    }
    if (typeof plugin.publisher !== 'string' || !plugin.publisher.trim()) {
      throw new Error(`plugin "${plugin.id}" is missing publisher`);
    }
    const pubKey = publishers[plugin.publisher];
    if (!pubKey) {
      throw new Error(`untrusted or unknown publisher "${plugin.publisher}" for plugin "${plugin.id}"`);
    }

    const versions: RegistryVersionEntry[] = Array.isArray(plugin.versions)
      ? plugin.versions
      : [plugin as unknown as RegistryVersionEntry];
    if (versions.length === 0) {
      throw new Error(`plugin "${plugin.id}" has no versions in registry index`);
    }

    for (const v of versions) {
      if (!isPlainObject(v) || typeof v.version !== 'string' || !parseSemver(v.version)) {
        throw new Error(`invalid version entry for plugin "${plugin.id}"`);
      }
      if (!verifyVersionEntrySignature(v, plugin.id, pubKey)) {
        throw new Error(`invalid publisher signature for ${plugin.id}@${v.version}`);
      }
    }
  }

  return true;
}

function compareSemverDesc(a: Semver, b: Semver): number {
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  if (a.patch !== b.patch) return b.patch - a.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return -1;
  if (b.prerelease === undefined) return 1;
  const pa = a.prerelease.split('.');
  const pb = b.prerelease.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined;
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined;
    if (na !== undefined && nb !== undefined) return nb - na;
    if (na !== undefined) return 1;
    if (nb !== undefined) return -1;
    return sa < sb ? 1 : -1;
  }
  return 0;
}

export function resolve(
  index: RegistryIndex,
  id: string,
  range = '*',
  engineVersion = PLUGIN_API_VERSION,
): ResolvedRegistryVersion {
  const plugins = getPluginsList(index);
  const plugin = plugins.find(p => p.id === id);
  if (!plugin) {
    throw new Error(`plugin "${id}" not found in registry index`);
  }
  const versions: RegistryVersionEntry[] = Array.isArray(plugin.versions)
    ? plugin.versions
    : [plugin as unknown as RegistryVersionEntry];

  const rangeMatched = versions.filter(v => satisfiesEngine(range, v.version));
  if (rangeMatched.length === 0) {
    throw new Error(`no version of plugin "${id}" satisfies range "${range}"`);
  }

  const engineMatched = rangeMatched.filter(v => satisfiesEngine(v.engine, engineVersion));
  if (engineMatched.length === 0) {
    const reqs = rangeMatched.map(v => `${v.version} (requires engine ${v.engine})`).join(', ');
    throw new Error(`incompatible engine version "${engineVersion}" for plugin "${id}": ${reqs}`);
  }

  const sorted = [...engineMatched].sort((a, b) => {
    const sa = parseSemver(a.version)!;
    const sb = parseSemver(b.version)!;
    return compareSemverDesc(sa, sb);
  });

  return {
    plugin,
    version: sorted[0]!,
    ...(index.baseUrl !== undefined ? { baseUrl: index.baseUrl } : {}),
  };
}

function assertSafeZipEntryPath(entryName: string): void {
  if (!entryName || entryName.includes('\0')) {
    throw new Error(`unsafe zip entry path "${entryName}"`);
  }
  if (entryName.startsWith('/') || entryName.startsWith('\\') || /^[a-zA-Z]:/.test(entryName)) {
    throw new Error(`unsafe zip entry path "${entryName}": absolute paths and drive letters are rejected`);
  }
  if (entryName.includes('\\')) {
    throw new Error(`unsafe zip entry path "${entryName}": backslash path separators are rejected`);
  }
  const segments = entryName.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '..' || seg === '.') {
      throw new Error(`unsafe zip entry path "${entryName}": path traversal segments are rejected`);
    }
    if (seg === '' && i !== segments.length - 1) {
      throw new Error(`unsafe zip entry path "${entryName}": empty path segments are rejected`);
    }
  }
}

/**
 * Inspect the raw ZIP central directory before extraction to reject:
 * 1. Any entry whose POSIX mode in external file attributes is a symbolic link (`S_IFLNK = 0o120000`).
 * 2. Any entry name in the central directory or local file headers with path traversal or absolute paths.
 */
function inspectZipHeaders(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate End of Central Directory (EOCD) record (signature 0x06054b50).
  let eocdOffset = -1;
  const minEocdSearch = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minEocdSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('invalid .cnlplugin zip archive: missing End of Central Directory');
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  let pos = cdOffset;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (pos + 46 > bytes.byteLength || view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('invalid .cnlplugin zip archive: corrupt central directory header');
    }
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const externalAttr = view.getUint32(pos + 38, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    if (pos + 46 + nameLen > bytes.byteLength) {
      throw new Error('invalid .cnlplugin zip archive: truncated entry filename');
    }
    const name = Buffer.from(bytes.buffer, bytes.byteOffset + pos + 46, nameLen).toString('utf8');
    assertSafeZipEntryPath(name);

    const posixFileType = (externalAttr >>> 16) & 0o170000;
    if (posixFileType === 0o120000) {
      throw new Error(`unsafe zip entry "${name}": symlinks are not allowed`);
    }

    // Also check the Local File Header filename so it cannot differ from the Central Directory filename.
    if (localHeaderOffset + 30 > bytes.byteLength || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`invalid .cnlplugin zip archive: corrupt local file header for "${name}"`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    if (localHeaderOffset + 30 + localNameLen > bytes.byteLength) {
      throw new Error(`invalid .cnlplugin zip archive: truncated local filename for "${name}"`);
    }
    const localName = Buffer.from(bytes.buffer, bytes.byteOffset + localHeaderOffset + 30, localNameLen).toString('utf8');
    assertSafeZipEntryPath(localName);
    if (localName !== name) {
      throw new Error(`unsafe zip archive: local header filename "${localName}" mismatches central directory "${name}"`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
}

function isPathInsideDir(rootDir: string, targetPath: string): boolean {
  const rel = relative(rootDir, targetPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)) {
    return false;
  }
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  return targetPath.startsWith(rootWithSep);
}

async function readPackageBytes(
  entryUrl: string,
  baseUrl: string | undefined,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<Uint8Array> {
  if (entryUrl.startsWith('http://') || entryUrl.startsWith('https://')) {
    return fetchBytes(entryUrl, { maxBytes, timeoutMs });
  }
  if (entryUrl.startsWith('file://')) {
    const filePath = fileURLToPath(entryUrl);
    if (!existsSync(filePath)) throw new Error(`plugin package not found: ${filePath}`);
    const st = statSync(filePath);
    if (st.size > maxBytes) throw new Error(`plugin package exceeds size limit (${st.size} > ${maxBytes} bytes)`);
    return new Uint8Array(readFileSync(filePath));
  }
  if (baseUrl && (baseUrl.startsWith('http://') || baseUrl.startsWith('https://'))) {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const resolvedUrl = new URL(entryUrl, normalizedBase).href;
    return fetchBytes(resolvedUrl, { maxBytes, timeoutMs });
  }
  const baseDir = baseUrl
    ? baseUrl.startsWith('file://')
      ? fileURLToPath(baseUrl)
      : resolvePath(baseUrl)
    : DEFAULT_REPO_REGISTRY_DIR;
  const resolvedPath = resolvePath(baseDir, entryUrl);
  if (!existsSync(resolvedPath)) {
    throw new Error(`plugin package not found: ${resolvedPath}`);
  }
  const st = statSync(resolvedPath);
  if (st.size > maxBytes) {
    throw new Error(`plugin package exceeds size limit (${st.size} > ${maxBytes} bytes)`);
  }
  return new Uint8Array(readFileSync(resolvedPath));
}

function isResolvedRegistryVersion(
  entry: ResolvedRegistryVersion | RegistryVersionEntry,
): entry is ResolvedRegistryVersion {
  return (
    isPlainObject(entry) &&
    isPlainObject((entry as unknown as Record<string, unknown>).plugin) &&
    isPlainObject((entry as unknown as Record<string, unknown>).version)
  );
}

export async function install(
  entry: ResolvedRegistryVersion | RegistryVersionEntry,
  opts: InstallOptions = {},
): Promise<InstalledPlugin> {
  const stateDir = resolveStateDir(opts.stateDir);
  const engineVersion = opts.engineVersion ?? PLUGIN_API_VERSION;
  const maxBytes = opts.maxBytes ?? MAX_PLUGIN_BYTES;

  let pluginEntry: RegistryPluginEntry | undefined;
  let versionEntry: RegistryVersionEntry;
  let baseUrl = opts.baseUrl;

  if (isResolvedRegistryVersion(entry)) {
    pluginEntry = entry.plugin;
    versionEntry = entry.version;
    baseUrl = baseUrl ?? entry.baseUrl ?? opts.index?.baseUrl;
  } else {
    versionEntry = entry;
    baseUrl = baseUrl ?? opts.index?.baseUrl;
    if (opts.index) {
      const plugins = getPluginsList(opts.index);
      pluginEntry = plugins.find(p =>
        Array.isArray(p.versions) &&
        p.versions.some(v => v.version === versionEntry.version && v.sha256 === versionEntry.sha256),
      );
    }
  }

  // 1. Engine range check against versionEntry.engine before downloading.
  if (!satisfiesEngine(versionEntry.engine, engineVersion)) {
    throw new Error(`incompatible plugin engine range "${versionEntry.engine}" for plugin-api "${engineVersion}"`);
  }

  // 2. Signature verification against publisher public key (and index verification if opts.index passed).
  let publisherPublicKey = opts.publisherPublicKey;
  if (opts.index) {
    verifyIndex(opts.index, opts.registryPublicKey, { stateDir });
    if (!publisherPublicKey && pluginEntry) {
      const publishers = getPublishersMap(opts.index);
      publisherPublicKey = publishers[pluginEntry.publisher];
      if (!publisherPublicKey) {
        throw new Error(`untrusted or unknown publisher "${pluginEntry.publisher}"`);
      }
    }
  }
  if (!versionEntry.signature || typeof versionEntry.signature !== 'string') {
    throw new Error('plugin version entry is missing signature');
  }
  if (publisherPublicKey) {
    const valid = pluginEntry
      ? verifyVersionEntrySignature(versionEntry, pluginEntry.id, publisherPublicKey)
      : verifySignature(versionEntry, versionEntry.signature, publisherPublicKey);
    if (!valid) {
      throw new Error('plugin version signature verification failed');
    }
  }

  // 3. Size validation before fetching.
  if (
    typeof versionEntry.size !== 'number' ||
    !Number.isInteger(versionEntry.size) ||
    versionEntry.size <= 0 ||
    versionEntry.size > maxBytes
  ) {
    throw new Error(`invalid or oversized plugin package size: ${String(versionEntry.size)}`);
  }

  // 4. Download / read archive bytes (cap download at min(maxBytes, versionEntry.size)).
  const bytes = await readPackageBytes(
    versionEntry.url,
    baseUrl,
    maxBytes,
    opts.timeoutMs,
  );

  // 5. Verify exact size and SHA-256 before inspecting or unzipping.
  if (bytes.byteLength !== versionEntry.size) {
    throw new Error(`package size mismatch: expected ${versionEntry.size} bytes, got ${bytes.byteLength}`);
  }
  const actualSha = sha256Hex(bytes);
  if (actualSha !== versionEntry.sha256.toLowerCase()) {
    throw new Error(`package sha256 mismatch: expected ${versionEntry.sha256}, got ${actualSha}`);
  }

  // 6. Inspect zip headers for symlinks and zip-slip before decompression.
  inspectZipHeaders(bytes);

  // 7. Unzip and validate every entry path + total uncompressed size.
  const unzipped = unzipSync(bytes);
  let totalUncompressed = 0;
  const entryNames = Object.keys(unzipped).sort();
  for (const name of entryNames) {
    assertSafeZipEntryPath(name);
    const data = unzipped[name]!;
    totalUncompressed += data.byteLength;
    if (totalUncompressed > maxBytes) {
      throw new Error(`extracted plugin exceeds size limit (${totalUncompressed} > ${maxBytes} bytes)`);
    }
  }

  const rawManifestBytes = unzipped['plugin.json'];
  if (!rawManifestBytes) {
    throw new Error('invalid .cnlplugin archive: missing plugin.json at root');
  }
  let rawManifestObj: unknown;
  try {
    rawManifestObj = JSON.parse(
      Buffer.from(rawManifestBytes.buffer, rawManifestBytes.byteOffset, rawManifestBytes.byteLength).toString('utf8'),
    );
  } catch (err) {
    throw new Error(`invalid plugin.json JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 8. Validate manifest and verify consistency against the signed entry.
  const manifest = validateManifest(rawManifestObj, engineVersion);
  const expectedId = pluginEntry?.id ?? versionEntry.id;
  if (expectedId !== undefined && manifest.id !== expectedId) {
    throw new Error(`plugin.json id "${manifest.id}" does not match registry entry id "${expectedId}"`);
  }
  if (manifest.version !== versionEntry.version) {
    throw new Error(`plugin.json version "${manifest.version}" does not match registry entry version "${versionEntry.version}"`);
  }
  if (manifest.engine !== versionEntry.engine) {
    throw new Error(`plugin.json engine "${manifest.engine}" does not match registry entry engine "${versionEntry.engine}"`);
  }
  const entryPermsSorted = [...versionEntry.permissions].sort();
  const manifestPermsSorted = [...manifest.permissions].sort();
  if (entryPermsSorted.join(',') !== manifestPermsSorted.join(',')) {
    throw new Error(
      `plugin.json permissions [${manifestPermsSorted.join(', ')}] do not match registry entry permissions [${entryPermsSorted.join(', ')}]`,
    );
  }

  // 9. Extract atomically: write to a temporary sibling directory, re-validate plugin.json on disk, then rename.
  const pluginParentDir = join(stateDir, 'plugins', manifest.id);
  mkdirSync(pluginParentDir, { recursive: true });
  const tempDir = join(pluginParentDir, `.tmp-${manifest.version}-${process.pid}-${Date.now()}`);
  const targetDir = join(pluginParentDir, manifest.version);

  try {
    mkdirSync(tempDir, { recursive: true });
    for (const name of entryNames) {
      if (name.endsWith('/')) continue;
      const destPath = resolvePath(tempDir, name);
      if (!isPathInsideDir(tempDir, destPath)) {
        throw new Error(`unsafe zip entry "${name}": escapes target directory`);
      }
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, unzipped[name]!);
    }

    const diskManifestPath = join(tempDir, 'plugin.json');
    if (!existsSync(diskManifestPath)) {
      throw new Error('extracted plugin is missing plugin.json');
    }
    const diskManifest = validateManifest(JSON.parse(readFileSync(diskManifestPath, 'utf8')), engineVersion);
    if (diskManifest.id !== manifest.id || diskManifest.version !== manifest.version) {
      throw new Error('re-validation of extracted plugin.json failed');
    }

    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    renameSync(tempDir, targetDir);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  // 10. Grants: install NEVER grants anything by itself unless explicitly requested via opts.grant or opts.approvePermissions.
  if (opts.grant === true) {
    setGrants(manifest.id, manifest.permissions, { stateDir });
  } else if (Array.isArray(opts.grant) && opts.grant.length > 0) {
    const allowed = opts.grant.filter(p => manifest.permissions.includes(p));
    setGrants(manifest.id, allowed, { stateDir });
  } else if (opts.approvePermissions && manifest.permissions.length > 0) {
    const approved = await opts.approvePermissions(manifest.permissions, manifest);
    if (approved) {
      setGrants(manifest.id, manifest.permissions, { stateDir });
    }
  }

  return {
    id: manifest.id,
    version: manifest.version,
    dir: targetDir,
    manifest,
    grants: getGrants(manifest.id, { stateDir }),
  };
}

interface StoredGrantsFile {
  [pluginId: string]: {
    permissions: PluginPermission[];
  };
}

function readGrantsMap(stateDir: string): Map<string, PluginPermission[]> {
  const grantsPath = join(stateDir, 'grants.json');
  const map = new Map<string, PluginPermission[]>();
  if (!existsSync(grantsPath)) return map;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(grantsPath, 'utf8'));
  } catch {
    return map;
  }
  if (!isPlainObject(raw)) return map;
  for (const [pluginId, val] of Object.entries(raw)) {
    const list = Array.isArray(val)
      ? val
      : isPlainObject(val) && Array.isArray(val.permissions)
        ? val.permissions
        : [];
    const valid = list.filter((p): p is PluginPermission => typeof p === 'string' && isValidPermission(p));
    map.set(pluginId, [...new Set(valid)].sort());
  }
  return map;
}

function writeGrantsMap(stateDir: string, map: Map<string, PluginPermission[]>): void {
  mkdirSync(stateDir, { recursive: true });
  const grantsPath = join(stateDir, 'grants.json');
  const out: StoredGrantsFile = {};
  for (const pluginId of [...map.keys()].sort()) {
    const perms = [...new Set(map.get(pluginId) ?? [])].sort();
    out[pluginId] = { permissions: perms };
  }
  writeFileSync(grantsPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

export function getGrants(id: string, opts: { stateDir?: string } = {}): PluginPermission[] {
  const stateDir = resolveStateDir(opts.stateDir);
  return readGrantsMap(stateDir).get(id) ?? [];
}

export function setGrants(
  id: string,
  permissions: PluginPermission[],
  opts: { stateDir?: string } = {},
): PluginPermission[] {
  for (const perm of permissions) {
    if (!isValidPermission(perm)) {
      throw new Error(`invalid plugin permission "${String(perm)}"`);
    }
  }
  const stateDir = resolveStateDir(opts.stateDir);
  const map = readGrantsMap(stateDir);
  const sorted = [...new Set(permissions)].sort();
  map.set(id, sorted);
  writeGrantsMap(stateDir, map);
  return sorted;
}

/** Add `permissions` to the granted set for plugin `id` in `<stateDir>/grants.json`. */
export function grant(
  id: string,
  permissions: PluginPermission[],
  opts: { stateDir?: string } = {},
): PluginPermission[] {
  for (const perm of permissions) {
    if (!isValidPermission(perm)) {
      throw new Error(`invalid plugin permission "${String(perm)}"`);
    }
  }
  const current = getGrants(id, opts);
  return setGrants(id, [...current, ...permissions], opts);
}

/** Revoke specific `permissions` (or all permissions when omitted/empty) for plugin `id`. */
export function revoke(
  id: string,
  permissions?: PluginPermission[],
  opts: { stateDir?: string } = {},
): PluginPermission[] {
  const current = getGrants(id, opts);
  if (!permissions || permissions.length === 0) {
    return setGrants(id, [], opts);
  }
  const toRemove = new Set<string>(permissions);
  const remaining = current.filter(p => !toRemove.has(p));
  return setGrants(id, remaining, opts);
}

export async function uninstall(
  id: string,
  opts: { version?: string; stateDir?: string } = {},
): Promise<boolean> {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`invalid plugin id "${id}"`);
  }
  const stateDir = resolveStateDir(opts.stateDir);
  const pluginDir = join(stateDir, 'plugins', id);
  if (!existsSync(pluginDir)) return false;

  if (opts.version) {
    const verDir = join(pluginDir, opts.version);
    if (!existsSync(verDir)) return false;
    rmSync(verDir, { recursive: true, force: true });
    const remaining = readdirSync(pluginDir).filter(name => !name.startsWith('.'));
    if (remaining.length === 0) {
      rmSync(pluginDir, { recursive: true, force: true });
      const grantsPath = join(stateDir, 'grants.json');
      if (existsSync(grantsPath)) {
        const map = readGrantsMap(stateDir);
        if (map.delete(id)) writeGrantsMap(stateDir, map);
      }
    }
    return true;
  }

  rmSync(pluginDir, { recursive: true, force: true });
  const grantsPath = join(stateDir, 'grants.json');
  if (existsSync(grantsPath)) {
    const map = readGrantsMap(stateDir);
    if (map.delete(id)) writeGrantsMap(stateDir, map);
  }
  return true;
}

export function listInstalled(opts: { stateDir?: string } = {}): InstalledPlugin[] {
  const stateDir = resolveStateDir(opts.stateDir);
  const pluginsRoot = join(stateDir, 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const grantsMap = readGrantsMap(stateDir);
  const results: InstalledPlugin[] = [];
  const pluginIds = readdirSync(pluginsRoot)
    .filter(name => !name.startsWith('.'))
    .sort();

  for (const id of pluginIds) {
    const idDir = join(pluginsRoot, id);
    if (!statSync(idDir).isDirectory()) continue;
    const versions = readdirSync(idDir)
      .filter(name => !name.startsWith('.') && parseSemver(name) !== undefined)
      .sort((a, b) => compareSemverDesc(parseSemver(a)!, parseSemver(b)!));

    for (const ver of versions) {
      const verDir = join(idDir, ver);
      const manifestPath = join(verDir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
        const rawGrants = grantsMap.get(manifest.id) ?? [];
        const effectiveGrants = rawGrants.filter(p => manifest.permissions.includes(p));
        results.push({
          id: manifest.id,
          version: manifest.version,
          dir: verDir,
          manifest,
          grants: effectiveGrants,
        });
      } catch {
        // Skip corrupt plugin directories.
      }
    }
  }
  return results;
}

function collectPackFiles(rootDir: string, currentDir: string, out: string[]): void {
  const names = readdirSync(currentDir).sort();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (name === 'node_modules') continue;
    if (name.endsWith('.cnlplugin')) continue;

    const fullPath = join(currentDir, name);
    const lst = lstatSync(fullPath);
    if (lst.isSymbolicLink()) {
      const rel = relative(rootDir, fullPath).split(sep).join('/');
      throw new Error(`symlinks are not allowed in plugin packages: ${rel}`);
    }
    if (lst.isDirectory()) {
      collectPackFiles(rootDir, fullPath, out);
    } else if (lst.isFile()) {
      const rel = relative(rootDir, fullPath).split(sep).join('/');
      out.push(rel);
    }
  }
}

export function pack(dir: string, opts: { maxBytes?: number } = {}): Uint8Array {
  const rootDir = resolvePath(dir);
  const maxBytes = opts.maxBytes ?? MAX_PLUGIN_BYTES;
  const manifestPath = join(rootDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`missing plugin.json in ${rootDir}`);
  }
  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  validateManifest(rawManifest);

  const relFiles: string[] = [];
  collectPackFiles(rootDir, rootDir, relFiles);
  relFiles.sort();

  const zipEntries: Zippable = {};
  let totalUncompressed = 0;

  for (const relPath of relFiles) {
    const fileBytes = new Uint8Array(readFileSync(join(rootDir, relPath)));
    totalUncompressed += fileBytes.byteLength;
    if (totalUncompressed > maxBytes) {
      throw new Error(`plugin contents exceed size limit (${totalUncompressed} > ${maxBytes} bytes)`);
    }
    zipEntries[relPath] = [fileBytes, { mtime: FIXED_ZIP_MTIME, level: 6 }];
  }

  const archived = zipSync(zipEntries, { mtime: FIXED_ZIP_MTIME, level: 6 });
  if (archived.byteLength > maxBytes) {
    throw new Error(`packed .cnlplugin exceeds size limit (${archived.byteLength} > ${maxBytes} bytes)`);
  }
  return archived;
}

export interface SignPackageOptions {
  /** Path to `.cnlplugin` file or plugin source directory, or raw `.cnlplugin` bytes. */
  packagePathOrBytes: string | Uint8Array;
  /** Publisher Ed25519 private key (PEM string, base64 seed, or file path). */
  publisherPrivateKey: string;
  /** Publisher ID (defaults to `manifest.publisher` or `'default'`). */
  publisher?: string;
  /** Path to `registry/` directory or `index.json` file to update. */
  indexPath?: string;
  /** Registry Ed25519 private key (PEM string, base64 seed, or file path) to re-sign the index. */
  registryPrivateKey?: string;
  /** Explicit download URL for the version entry. */
  url?: string;
}

export interface SignPackageResult {
  manifest: PluginManifest;
  publisher: string;
  versionEntry: RegistryVersionEntry;
  index?: RegistryIndex;
  indexSig?: string;
  indexFilePath?: string;
  sigFilePath?: string;
}

/**
 * Sign a `.cnlplugin` package with the publisher private key, and optionally add/update
 * the entry in a registry `index.json` + re-sign `index.json` and `index.sig` with the registry key.
 */
export function signPackageToIndex(opts: SignPackageOptions): SignPackageResult {
  let bytes: Uint8Array;
  let sourceFilePath: string | undefined;

  if (opts.packagePathOrBytes instanceof Uint8Array) {
    bytes = opts.packagePathOrBytes;
  } else {
    const resolvedTarget = resolvePath(opts.packagePathOrBytes);
    if (!existsSync(resolvedTarget)) {
      throw new Error(`package not found: ${resolvedTarget}`);
    }
    if (statSync(resolvedTarget).isDirectory()) {
      bytes = pack(resolvedTarget);
    } else {
      sourceFilePath = resolvedTarget;
      bytes = new Uint8Array(readFileSync(resolvedTarget));
    }
  }

  inspectZipHeaders(bytes);
  const unzipped = unzipSync(bytes);
  const rawManifestBytes = unzipped['plugin.json'];
  if (!rawManifestBytes) {
    throw new Error('invalid .cnlplugin archive: missing plugin.json at root');
  }
  const manifest = validateManifest(
    JSON.parse(
      Buffer.from(rawManifestBytes.buffer, rawManifestBytes.byteOffset, rawManifestBytes.byteLength).toString('utf8'),
    ),
  );

  const publisher = opts.publisher?.trim() || manifest.publisher?.trim() || 'default';
  const sha256 = sha256Hex(bytes);
  const size = bytes.byteLength;

  let indexFilePath: string | undefined;
  let indexDir: string | undefined;
  if (opts.indexPath) {
    const resolvedIdx = resolvePath(opts.indexPath);
    if (existsSync(resolvedIdx) && statSync(resolvedIdx).isDirectory()) {
      indexDir = resolvedIdx;
      indexFilePath = join(resolvedIdx, 'index.json');
    } else if (resolvedIdx.endsWith('.json')) {
      indexFilePath = resolvedIdx;
      indexDir = dirname(resolvedIdx);
    } else {
      indexDir = resolvedIdx;
      indexFilePath = join(resolvedIdx, 'index.json');
    }
  }

  let entryUrl = opts.url?.trim();
  if (!entryUrl) {
    if (indexDir) {
      if (sourceFilePath && isPathInsideDir(indexDir, sourceFilePath)) {
        entryUrl = relative(indexDir, sourceFilePath).split(sep).join('/');
      } else {
        const pkgRel = `packages/${manifest.id}-${manifest.version}.cnlplugin`;
        const destPkgPath = join(indexDir, pkgRel);
        mkdirSync(dirname(destPkgPath), { recursive: true });
        if (sourceFilePath) {
          copyFileSync(sourceFilePath, destPkgPath);
        } else {
          writeFileSync(destPkgPath, bytes);
        }
        entryUrl = pkgRel;
      }
    } else if (sourceFilePath) {
      entryUrl = basename(sourceFilePath);
    } else {
      entryUrl = `${manifest.id}-${manifest.version}.cnlplugin`;
    }
  }

  const unsignedEntry = {
    version: manifest.version,
    engine: manifest.engine,
    url: entryUrl,
    sha256,
    size,
    permissions: [...manifest.permissions].sort(),
    contributes: contributedKinds(manifest),
  };
  const signature = sign(unsignedEntry, opts.publisherPrivateKey);
  const versionEntry: RegistryVersionEntry = {
    ...unsignedEntry,
    signature,
  };

  if (!indexFilePath || !indexDir) {
    return { manifest, publisher, versionEntry };
  }

  mkdirSync(indexDir, { recursive: true });
  let existingPublishers: Record<string, string> = {};
  let existingPlugins: RegistryPluginEntry[] = [];

  if (existsSync(indexFilePath)) {
    const raw = JSON.parse(readFileSync(indexFilePath, 'utf8')) as RegistryIndex;
    existingPublishers = getPublishersMap(raw);
    existingPlugins = Array.isArray(raw.plugins)
      ? raw.plugins
      : Array.isArray(raw.entries)
        ? raw.entries
        : [];
  }

  const pubKeyPem = derivePublicKeyPem(opts.publisherPrivateKey);
  existingPublishers[publisher] = pubKeyPem;

  const sortedPublishers: Record<string, string> = {};
  for (const k of Object.keys(existingPublishers).sort()) {
    sortedPublishers[k] = existingPublishers[k]!;
  }

  const pluginIdx = existingPlugins.findIndex(p => p.id === manifest.id);
  const nextPlugin: RegistryPluginEntry = pluginIdx >= 0
    ? {
        ...existingPlugins[pluginIdx]!,
        id: manifest.id,
        name: manifest.name,
        summary: manifest.summary ?? existingPlugins[pluginIdx]!.summary ?? manifest.name,
        publisher,
        ...(manifest.license ? { license: manifest.license } : {}),
        versions: [
          ...existingPlugins[pluginIdx]!.versions.filter(v => v.version !== manifest.version),
          versionEntry,
        ].sort((a, b) => -compareSemverDesc(parseSemver(a.version)!, parseSemver(b.version)!)),
      }
    : {
        id: manifest.id,
        name: manifest.name,
        summary: manifest.summary ?? manifest.name,
        publisher,
        ...(manifest.license ? { license: manifest.license } : {}),
        versions: [versionEntry],
      };

  const nextPlugins = [
    ...existingPlugins.filter(p => p.id !== manifest.id),
    nextPlugin,
  ].sort((a, b) => a.id.localeCompare(b.id));

  let regPrivKey = opts.registryPrivateKey?.trim();
  if (!regPrivKey) {
    const devPem = join(indexDir, 'registry.dev.pem');
    const devKey = join(indexDir, 'registry.key');
    if (existsSync(devPem)) regPrivKey = devPem;
    else if (existsSync(devKey)) regPrivKey = devKey;
  }
  if (!regPrivKey) {
    throw new Error('missing registry private key (--registry-key) to sign registry index');
  }

  const keysSignature = sign({ publishers: sortedPublishers }, regPrivKey);
  const indexData: RegistryIndex = {
    version: 1,
    keys: {
      ...sortedPublishers,
      publishers: sortedPublishers,
      signature: keysSignature,
    },
    plugins: nextPlugins,
  };

  const canonicalObj = canonicalize(indexData) as RegistryIndex;
  const indexSig = sign(canonicalObj, regPrivKey);
  const sigFilePath = join(indexDir, 'index.sig');

  writeFileSync(indexFilePath, `${JSON.stringify(canonicalObj, null, 2)}\n`, 'utf8');
  writeFileSync(sigFilePath, `${indexSig}\n`, 'utf8');
  attachIndexMetadata(canonicalObj, indexDir, indexSig, true);

  return {
    manifest,
    publisher,
    versionEntry,
    index: canonicalObj,
    indexSig,
    indexFilePath,
    sigFilePath,
  };
}
