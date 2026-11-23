// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

/** Default trusted Ed25519 root public key for the CadLLM plugin registry (`registry/registry.pub`). */
export const EMBEDDED_REGISTRY_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEA2Cy/9gOCq9K9KLo3cueaY56N4SNy+zNXCKMn2je64jI=',
  '-----END PUBLIC KEY-----',
].join('\n');

/** ASN.1 DER SPKI prefix for a 32-byte raw Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PlainPermission {
  permission: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

export interface StoreVersionEntry {
  id?: string;
  version: string;
  engine: string;
  url: string;
  sha256: string;
  size: number;
  permissions: string[];
  contributes: string[];
  signature: string;
}

export interface StorePluginEntry {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  license: string;
  versions: StoreVersionEntry[];
}

export interface VerifiedStorePlugin {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  license: string;
  latestVersion: StoreVersionEntry;
  versions: StoreVersionEntry[];
  plainPermissions: PlainPermission[];
  installCommand: string;
}

export type VerifyRegistryOutcome =
  | {
      ok: true;
      plugins: VerifiedStorePlugin[];
      publishers: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
      plugins: [];
    };

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

/** Serialize `value` to canonical JSON (recursively sorted keys, zero whitespace). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

/** Parse an SPKI PEM or base64 Ed25519 public key into a 44-byte SPKI DER buffer. */
export function parseEd25519SpkiDer(keyPemOrB64: string): Uint8Array {
  if (typeof keyPemOrB64 !== 'string') {
    throw new Error('public key must be a string');
  }
  const trimmed = keyPemOrB64.trim();
  if (!trimmed) {
    throw new Error('empty public key');
  }
  const body = trimmed
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new Error('invalid base64 in public key');
  }
  const raw = base64ToBytes(body);
  if (raw.length === 32) {
    const spki = new Uint8Array(44);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki.set(raw, 12);
    return spki;
  }
  if (raw.length === 44) {
    for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
      if (raw[i] !== ED25519_SPKI_PREFIX[i]) {
        throw new Error('public key SPKI header is not Ed25519');
      }
    }
    return raw;
  }
  throw new Error(`unexpected Ed25519 public key byte length (${raw.length})`);
}

export function decodeSignatureBytes(signature: string): Uint8Array | undefined {
  if (typeof signature !== 'string') return undefined;
  const trimmed = signature.trim();
  if (!trimmed) return undefined;
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(trimmed) && !/^[A-Za-z0-9+/]{86}$/.test(trimmed)) {
    return undefined;
  }
  const padded = trimmed.endsWith('==') ? trimmed : `${trimmed}==`;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(padded);
  } catch {
    return undefined;
  }
  if (bytes.length !== 64 || bytesToBase64(bytes) !== padded) {
    return undefined;
  }
  return bytes;
}

export function payloadToBytes(entry: unknown): Uint8Array {
  if (entry instanceof Uint8Array) return entry;
  if (typeof entry === 'string') return new TextEncoder().encode(entry);
  if (isPlainObject(entry) && ('signature' in entry || 'baseUrl' in entry)) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'signature' || k === 'baseUrl') continue;
      copy[k] = v;
    }
    return new TextEncoder().encode(canonicalJson(copy));
  }
  return new TextEncoder().encode(canonicalJson(entry));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Verify an Ed25519 signature over `entry` (canonical JSON or bytes) using WebCrypto `crypto.subtle`. */
export async function verifySignatureWebCrypto(
  entry: unknown,
  signature: string,
  publicKeyPemOrB64: string,
): Promise<boolean> {
  const sigBytes = decodeSignatureBytes(signature);
  if (!sigBytes) return false;
  let spki: Uint8Array;
  try {
    spki = parseEd25519SpkiDer(publicKeyPemOrB64);
  } catch {
    return false;
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API is unavailable in this environment');
  }
  const data = payloadToBytes(entry);
  try {
    const key = await subtle.importKey('spki', toArrayBuffer(spki), { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, key, toArrayBuffer(sigBytes), toArrayBuffer(data));
  } catch {
    try {
      const rawKey = spki.subarray(12);
      const key = await subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'Ed25519' }, false, ['verify']);
      return await subtle.verify({ name: 'Ed25519' }, key, toArrayBuffer(sigBytes), toArrayBuffer(data));
    } catch {
      return false;
    }
  }
}

function canonicalIndexWithoutBaseUrl(index: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(index)) {
    if (k === 'baseUrl') continue;
    out[k] = v;
  }
  return out;
}

function extractPublishersMap(index: Record<string, unknown>): Record<string, string> {
  if (!isPlainObject(index.keys)) {
    throw new Error('invalid registry index: missing "keys" object');
  }
  const keysObj = index.keys;
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

async function verifyVersionEntrySignature(
  v: Record<string, unknown>,
  pluginId: string,
  publisherPublicKey: string,
): Promise<boolean> {
  if (typeof v.signature !== 'string' || !v.signature.trim()) return false;
  if (v.id !== undefined && v.id !== pluginId) return false;
  if (await verifySignatureWebCrypto(v, v.signature, publisherPublicKey)) return true;
  if (await verifySignatureWebCrypto({ id: pluginId, ...v }, v.signature, publisherPublicKey)) return true;
  return false;
}

/** Translate a CadLLM plugin permission token into plain human words. */
export function describePermissionPlain(perm: string): PlainPermission {
  const trimmed = perm.trim();
  if (trimmed === 'project:read') {
    return {
      permission: trimmed,
      title: 'Read your circuits',
      detail: 'Inspect components, nets, and placements in the active project.',
      risk: 'low',
    };
  }
  if (trimmed === 'project:write') {
    return {
      permission: trimmed,
      title: 'Change your circuits',
      detail: 'Propose or apply edits to components, wiring, and layouts.',
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('net:')) {
    const host = trimmed.slice(4).trim() || '(unknown host)';
    return {
      permission: trimmed,
      title: `Connect to ${host}`,
      detail: `Open outbound network connections to ${host}.`,
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('fs:read:')) {
    const target = trimmed.slice(8).trim() || '(path)';
    return {
      permission: trimmed,
      title: `Read files in ${target}`,
      detail: `Read local files from ${target}.`,
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('fs:write:')) {
    const target = trimmed.slice(9).trim() || '(path)';
    return {
      permission: trimmed,
      title: `Write files in ${target}`,
      detail: `Create or modify local files in ${target}.`,
      risk: 'high',
    };
  }
  return {
    permission: trimmed,
    title: `Custom capability (${trimmed})`,
    detail: `Grants the "${trimmed}" permission to the plugin.`,
    risk: 'high',
  };
}

/**
 * Verify a registry `index.json` object and its detached `index.sig` signature using WebCrypto Ed25519
 * against `registryPublicKey` (defaulting to `EMBEDDED_REGISTRY_PUBLIC_KEY`), plus every publisher
 * signature on every plugin version entry.
 */
export async function verifyIndexWebCrypto(
  index: unknown,
  indexSig: string,
  registryPublicKey: string = EMBEDDED_REGISTRY_PUBLIC_KEY,
): Promise<VerifyRegistryOutcome> {
  try {
    if (!isPlainObject(index)) {
      throw new Error('invalid registry index: expected JSON object');
    }
    try {
      parseEd25519SpkiDer(registryPublicKey);
    } catch (err) {
      throw new Error(`invalid registry public key: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (typeof indexSig !== 'string' || !indexSig.trim()) {
      throw new Error('missing detached registry signature (index.sig)');
    }

    const cleanIndex = canonicalIndexWithoutBaseUrl(index);
    const sigOk = await verifySignatureWebCrypto(cleanIndex, indexSig.trim(), registryPublicKey);
    if (!sigOk) {
      throw new Error('registry index.sig signature verification failed');
    }

    const publishers = extractPublishersMap(index);
    const keysObj = index.keys as Record<string, unknown>;
    const keysSig = typeof keysObj.signature === 'string' ? keysObj.signature : undefined;
    if (!keysSig) {
      throw new Error('registry index is missing keys.signature');
    }

    const keysValid =
      (await verifySignatureWebCrypto({ publishers }, keysSig, registryPublicKey)) ||
      (await verifySignatureWebCrypto({ ...cleanIndex, keys: { publishers } }, keysSig, registryPublicKey));
    if (!keysValid) {
      throw new Error('registry keys signature verification failed');
    }

    if (isPlainObject(keysObj.publishers)) {
      for (const [k, v] of Object.entries(keysObj)) {
        if (k === 'publishers' || k === 'signature') continue;
        if ((keysObj.publishers as Record<string, unknown>)[k] !== v) {
          throw new Error(`registry key mismatch for publisher "${k}"`);
        }
      }
    }

    const rawPlugins = Array.isArray(index.plugins)
      ? index.plugins
      : Array.isArray(index.entries)
        ? index.entries
        : undefined;
    if (!rawPlugins) {
      throw new Error('invalid registry index: missing "plugins" array');
    }

    const verifiedPlugins: VerifiedStorePlugin[] = [];

    for (const rawPlugin of rawPlugins) {
      if (!isPlainObject(rawPlugin) || typeof rawPlugin.id !== 'string' || !rawPlugin.id.trim()) {
        throw new Error('invalid plugin entry in registry index: missing id');
      }
      const pluginId = rawPlugin.id.trim();
      if (typeof rawPlugin.publisher !== 'string' || !rawPlugin.publisher.trim()) {
        throw new Error(`plugin "${pluginId}" is missing publisher`);
      }
      const publisher = rawPlugin.publisher.trim();
      const pubKey = publishers[publisher];
      if (!pubKey) {
        throw new Error(`untrusted or unknown publisher "${publisher}" for plugin "${pluginId}"`);
      }

      const rawVersions = Array.isArray(rawPlugin.versions) ? rawPlugin.versions : [];
      if (rawVersions.length === 0) {
        throw new Error(`plugin "${pluginId}" has no versions in registry index`);
      }

      const versions: StoreVersionEntry[] = [];
      for (const rv of rawVersions) {
        if (!isPlainObject(rv) || typeof rv.version !== 'string' || !SEMVER_RE.test(rv.version.trim())) {
          throw new Error(`invalid version entry for plugin "${pluginId}"`);
        }
        const entryOk = await verifyVersionEntrySignature(rv, pluginId, pubKey);
        if (!entryOk) {
          throw new Error(`invalid publisher signature for ${pluginId}@${rv.version}`);
        }
        versions.push({
          ...(typeof rv.id === 'string' ? { id: rv.id } : {}),
          version: rv.version.trim(),
          engine: typeof rv.engine === 'string' ? rv.engine : '*',
          url: typeof rv.url === 'string' ? rv.url : '',
          sha256: typeof rv.sha256 === 'string' ? rv.sha256 : '',
          size: typeof rv.size === 'number' ? rv.size : 0,
          permissions: Array.isArray(rv.permissions) ? rv.permissions.map(String) : [],
          contributes: Array.isArray(rv.contributes) ? rv.contributes.map(String) : [],
          signature: String(rv.signature),
        });
      }

      const latestVersion = versions[versions.length - 1]!;
      verifiedPlugins.push({
        id: pluginId,
        name: typeof rawPlugin.name === 'string' && rawPlugin.name.trim() ? rawPlugin.name.trim() : pluginId,
        summary: typeof rawPlugin.summary === 'string' ? rawPlugin.summary.trim() : '',
        publisher,
        license: typeof rawPlugin.license === 'string' && rawPlugin.license.trim() ? rawPlugin.license.trim() : 'Unspecified',
        latestVersion,
        versions,
        plainPermissions: latestVersion.permissions.map(describePermissionPlain),
        installCommand: `cadllm plugin install ${pluginId}`,
      });
    }

    return {
      ok: true,
      plugins: verifiedPlugins,
      publishers,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      plugins: [],
    };
  }
}
