// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContributionKind, PluginPermission } from '@cadllm/plugin-api';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  getGrants,
  grant,
  install,
  keygen,
  listInstalled,
  loadIndex,
  pack,
  resolve as resolveVersion,
  revoke,
  setGrants,
  sha256Hex,
  sign,
  signPackageToIndex,
  uninstall,
  verifyIndex,
  verifySignature,
  type RegistryIndex,
} from '../src/index.ts';

function createSamplePluginDir(baseDir: string, overrides: Record<string, unknown> = {}): string {
  mkdirSync(join(baseDir, 'parts'), { recursive: true });
  mkdirSync(join(baseDir, 'src'), { recursive: true });
  const manifest = {
    id: 'org.example.demo',
    name: 'Demo Sensor Pack',
    version: '1.0.0',
    summary: 'Deterministic test plugin',
    publisher: 'cadllm-examples',
    engine: '^1.0.0',
    license: 'MIT',
    main: 'src/index.ts',
    permissions: ['project:read', 'net:api.example.com'],
    contributes: {
      parts: 'parts',
      tools: [{ name: 'calc_demo', summary: 'demo tool' }],
    },
    ...overrides,
  };
  writeFileSync(join(baseDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(baseDir, 'parts', 'ldr.json'),
    JSON.stringify({
      id: 'ldr',
      name: 'LDR',
      summary: 'Photoresistor',
      category: 'sensor',
      refPrefix: 'R',
      pins: [
        { id: '1', name: '1', type: 'passive' },
        { id: '2', name: '2', type: 'passive' },
      ],
    }),
  );
  writeFileSync(join(baseDir, 'src', 'index.ts'), '// SPDX-License-Identifier: MIT\nexport const ok = true;\n');
  return baseDir;
}

/** Set a custom external file attribute (e.g. POSIX symlink mode) on an entry in a valid ZIP buffer. */
function patchZipCentralDirExternalAttr(zipBytes: Uint8Array, targetEntryName: string, externalAttr: number): Uint8Array {
  const copy = new Uint8Array(zipBytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  let eocd = -1;
  for (let i = copy.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const name = Buffer.from(copy.buffer, copy.byteOffset + pos + 46, nameLen).toString('utf8');
    if (name === targetEntryName) {
      view.setUint32(pos + 38, externalAttr >>> 0, true);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return copy;
}

describe('@cadllm/registry', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];
  const prevStateDir = process.env.CADLLM_STATE_DIR;

  function makeTemp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  afterEach(async () => {
    if (prevStateDir === undefined) delete process.env.CADLLM_STATE_DIR;
    else process.env.CADLLM_STATE_DIR = prevStateDir;
    while (servers.length) {
      const s = servers.pop()!;
      await new Promise<void>(res => s.close(() => res()));
    }
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('verifies the committed repository registry in registry/ using only public keys', async () => {
    const repoRegDir = resolve(import.meta.dirname, '../../../registry');
    const stateDir = makeTemp('cadllm-repo-reg-state-');
    process.env.CADLLM_STATE_DIR = stateDir;

    expect(existsSync(join(repoRegDir, 'registry.pub'))).toBe(true);
    expect(existsSync(join(repoRegDir, 'index.json'))).toBe(true);
    expect(existsSync(join(repoRegDir, 'index.sig'))).toBe(true);
    expect(existsSync(join(repoRegDir, 'publishers', 'cadllm-examples.pub'))).toBe(true);
    expect(existsSync(join(repoRegDir, 'README.md'))).toBe(true);

    // No private keys may exist anywhere in the committed registry directory
    expect(existsSync(join(repoRegDir, 'registry.dev.pem'))).toBe(false);
    expect(existsSync(join(repoRegDir, 'registry.pem'))).toBe(false);
    expect(existsSync(join(repoRegDir, 'registry.key'))).toBe(false);
    expect(existsSync(join(repoRegDir, 'publishers', 'cadllm-examples.dev.pem'))).toBe(false);
    expect(existsSync(join(repoRegDir, 'publishers', 'cadllm-examples.pem'))).toBe(false);
    expect(existsSync(join(repoRegDir, 'publishers', 'cadllm-examples.key'))).toBe(false);

    const regPub = readFileSync(join(repoRegDir, 'registry.pub'), 'utf8');
    const pubPub = readFileSync(join(repoRegDir, 'publishers', 'cadllm-examples.pub'), 'utf8').trim();
    const index = await loadIndex(repoRegDir, { stateDir });
    expect(verifyIndex(index, undefined, { stateDir })).toBe(true);
    expect(verifyIndex(index, regPub)).toBe(true);
    expect(index.keys.publishers['cadllm-examples']?.trim()).toBe(pubPub);
  });

  it('produces a deterministic .cnlplugin sha256 across calls, mtimes, and excludes node_modules + dotfiles', () => {
    const dirA = createSamplePluginDir(makeTemp('cadllm-pack-a-'));
    // Add excluded files: dotfiles, dotdirs, node_modules, and stray .cnlplugin files
    writeFileSync(join(dirA, '.env'), 'SECRET=123');
    mkdirSync(join(dirA, '.git'), { recursive: true });
    writeFileSync(join(dirA, '.git', 'config'), 'gitcfg');
    mkdirSync(join(dirA, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(dirA, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    writeFileSync(join(dirA, 'old.cnlplugin'), 'ignore me');

    const dirB = createSamplePluginDir(makeTemp('cadllm-pack-b-'));
    const past = new Date(2021, 5, 15, 12, 30, 0);
    utimesSync(join(dirB, 'plugin.json'), past, past);
    utimesSync(join(dirB, 'src', 'index.ts'), past, past);

    const bytesA1 = pack(dirA);
    const bytesA2 = pack(dirA);
    const bytesB = pack(dirB);

    expect(sha256Hex(bytesA1)).toBe(sha256Hex(bytesA2));
    expect(sha256Hex(bytesA1)).toBe(sha256Hex(bytesB));
    expect(Buffer.compare(Buffer.from(bytesA1), Buffer.from(bytesB))).toBe(0);

    // Enforce size cap in pack()
    expect(() => pack(dirA, { maxBytes: 50 })).toThrow(/exceeds? size limit/);
  });

  it('rejects symlinks inside plugin directory when packing', () => {
    const dir = createSamplePluginDir(makeTemp('cadllm-pack-symlink-'));
    const outside = join(makeTemp('cadllm-outside-'), 'secret.txt');
    writeFileSync(outside, 'secret');
    try {
      symlinkSync(outside, join(dir, 'leak.txt'));
    } catch {
      // On Windows without Developer Mode privileges, symlinkSync may throw EPERM; skip only the creation if OS denies.
      return;
    }
    expect(() => pack(dir)).toThrow(/symlinks are not allowed/);
  });

  it('round-trips keygen, sign, verifySignature, and verifyIndex (both PEM and raw base64 public keys)', async () => {
    const regKeys = keygen();
    const pubKeys = keygen();

    const payload = { b: 2, a: [1, { d: 4, c: 3 }] };
    const sig = sign(payload, regKeys.privateKey);
    expect(verifySignature({ a: [1, { c: 3, d: 4 }], b: 2 }, sig, regKeys.publicKey)).toBe(true);
    expect(verifySignature(payload, sig, pubKeys.publicKey)).toBe(false);

    // Raw 32-byte base64 Ed25519 public key (strip 12-byte SPKI header from DER)
    const spkiDer = createPublicKey(pubKeys.publicKey).export({ type: 'spki', format: 'der' });
    const rawPubBase64 = spkiDer.subarray(12).toString('base64');
    const entrySig = sign({ hello: 'world' }, pubKeys.privateKey);
    expect(verifySignature({ hello: 'world' }, entrySig, rawPubBase64)).toBe(true);
  });

  it('rejects every tampered index, entry, signature, key, engine range, and zip case', async () => {
    const regDir = makeTemp('cadllm-reg-');
    const pluginDir = createSamplePluginDir(makeTemp('cadllm-src-'));
    const stateDir = makeTemp('cadllm-state-');
    process.env.CADLLM_STATE_DIR = stateDir;

    const regKeys = keygen();
    const pubKeys = keygen();
    const wrongKeys = keygen();

    writeFileSync(join(regDir, 'registry.pub'), regKeys.publicKey);
    writeFileSync(join(regDir, 'registry.dev.pem'), regKeys.privateKey);

    const signed = signPackageToIndex({
      packagePathOrBytes: pluginDir,
      publisherPrivateKey: pubKeys.privateKey,
      publisher: 'cadllm-examples',
      indexPath: regDir,
      registryPrivateKey: regKeys.privateKey,
    });

    const validIndex = await loadIndex(regDir);
    expect(verifyIndex(validIndex, regKeys.publicKey)).toBe(true);

    // 1. Tampered index.json metadata on disk without re-signing index.sig
    const rawIndexJson = JSON.parse(readFileSync(join(regDir, 'index.json'), 'utf8')) as RegistryIndex;
    const tamperedIndexFileDir = makeTemp('cadllm-tampered-idx-');
    const tamperedMeta = structuredClone(rawIndexJson);
    tamperedMeta.plugins[0]!.summary = 'Tampered summary by attacker';
    writeFileSync(join(tamperedIndexFileDir, 'index.json'), JSON.stringify(tamperedMeta, null, 2));
    writeFileSync(join(tamperedIndexFileDir, 'index.sig'), readFileSync(join(regDir, 'index.sig'), 'utf8'));
    const loadedTamperedMeta = await loadIndex(tamperedIndexFileDir);
    expect(() => verifyIndex(loadedTamperedMeta, regKeys.publicKey)).toThrow(/index\.sig signature verification failed/);

    // 2. Tampered index.sig
    const tamperedSigDir = makeTemp('cadllm-tampered-sig-');
    writeFileSync(join(tamperedSigDir, 'index.json'), readFileSync(join(regDir, 'index.json'), 'utf8'));
    const flippedIndexSig = `${signed.indexSig!.slice(0, 10)}${signed.indexSig![10] === 'A' ? 'B' : 'A'}${signed.indexSig!.slice(11)}`;
    writeFileSync(join(tamperedSigDir, 'index.sig'), flippedIndexSig);
    const loadedTamperedSig = await loadIndex(tamperedSigDir);
    expect(() => verifyIndex(loadedTamperedSig, regKeys.publicKey)).toThrow(/index\.sig signature verification failed/);

    // 3. Untrusted registry public key
    expect(() => verifyIndex(validIndex, wrongKeys.publicKey)).toThrow(/signature verification failed/);

    // 4. Tampered publisher public key in keys.publishers
    const tamperedPubKeyIndex: RegistryIndex = structuredClone(rawIndexJson);
    tamperedPubKeyIndex.keys.publishers['cadllm-examples'] = wrongKeys.publicKey;
    expect(() => verifyIndex(tamperedPubKeyIndex, regKeys.publicKey)).toThrow(/keys signature verification failed/);

    // 5. Tampered entry field (sha256, size, permissions, url, engine) in signed index
    const tamperedEntrySha: RegistryIndex = structuredClone(rawIndexJson);
    tamperedEntrySha.plugins[0]!.versions[0]!.sha256 = '0'.repeat(64);
    expect(() => verifyIndex(tamperedEntrySha, regKeys.publicKey)).toThrow(/invalid publisher signature/);

    const tamperedEntryPerms: RegistryIndex = structuredClone(rawIndexJson);
    tamperedEntryPerms.plugins[0]!.versions[0]!.permissions = [];
    expect(() => verifyIndex(tamperedEntryPerms, regKeys.publicKey)).toThrow(/invalid publisher signature/);

    // 6. Tampered entry signature (including last base64 character before '==')
    const tamperedEntrySig: RegistryIndex = structuredClone(rawIndexJson);
    const origEntrySig = tamperedEntrySig.plugins[0]!.versions[0]!.signature;
    const charAt85 = origEntrySig[85] === 'A' ? 'B' : 'A';
    tamperedEntrySig.plugins[0]!.versions[0]!.signature = `${origEntrySig.slice(0, 85)}${charAt85}==`;
    expect(() => verifyIndex(tamperedEntrySig, regKeys.publicKey)).toThrow(/invalid publisher signature/);

    // 7. Unknown / untrusted publisher ID on plugin entry
    const unknownPublisherIndex: RegistryIndex = structuredClone(rawIndexJson);
    unknownPublisherIndex.plugins[0]!.publisher = 'unknown-actor';
    expect(() => verifyIndex(unknownPublisherIndex, regKeys.publicKey)).toThrow(/untrusted or unknown publisher/);

    // 8. Incompatible engine range rejected in resolve() and install()
    const badEngineDir = createSamplePluginDir(makeTemp('cadllm-bad-eng-'), { engine: '^2.0.0' });
    // Build an index entry requiring ^2.0.0
    const badEngineVersionEntry = {
      ...signed.versionEntry,
      engine: '^2.0.0',
    };
    badEngineVersionEntry.signature = sign(badEngineVersionEntry, pubKeys.privateKey);
    const badEngineIndex: RegistryIndex = {
      version: 1,
      keys: rawIndexJson.keys,
      plugins: [{ ...rawIndexJson.plugins[0]!, versions: [badEngineVersionEntry] }],
    };
    expect(() => resolveVersion(badEngineIndex, 'org.example.demo')).toThrow(/incompatible engine version/);
    await expect(
      install(
        { plugin: badEngineIndex.plugins[0]!, version: badEngineVersionEntry, baseUrl: regDir },
        { stateDir, publisherPublicKey: pubKeys.publicKey },
      ),
    ).rejects.toThrow(/incompatible plugin engine range/);
    void badEngineDir;

    // 9. Tampered .cnlplugin zip bytes on disk (sha256 mismatch and size mismatch)
    const pkgPath = join(regDir, signed.versionEntry.url);
    const origPkgBytes = readFileSync(pkgPath);
    const corruptedSameSize = Buffer.from(origPkgBytes);
    const lastIdx = corruptedSameSize.length - 1;
    corruptedSameSize[lastIdx] = (corruptedSameSize[lastIdx] ?? 0) ^ 0xff;
    writeFileSync(pkgPath, corruptedSameSize);

    const resolved = resolveVersion(validIndex, 'org.example.demo');
    await expect(
      install(resolved, { stateDir, index: validIndex, registryPublicKey: regKeys.publicKey }),
    ).rejects.toThrow(/package sha256 mismatch/);

    // Truncated zip -> size mismatch
    writeFileSync(pkgPath, origPkgBytes.subarray(0, origPkgBytes.length - 4));
    await expect(
      install(resolved, { stateDir, index: validIndex, registryPublicKey: regKeys.publicKey }),
    ).rejects.toThrow(/package size mismatch/);

    // Restore valid zip bytes
    writeFileSync(pkgPath, origPkgBytes);

    // 10. Mismatched plugin.json id/version/permissions inside zip vs signed entry
    const mismatchZipBytes = zipSync({
      'plugin.json': Buffer.from(
        JSON.stringify({
          id: 'org.evil.impersonator',
          name: 'Evil',
          version: '1.0.0',
          engine: '^1.0.0',
          license: 'MIT',
          permissions: ['project:read', 'net:api.example.com'],
          contributes: {},
        }),
      ),
    });
    const mismatchPath = join(regDir, 'packages', 'mismatch.cnlplugin');
    writeFileSync(mismatchPath, mismatchZipBytes);
    const mismatchEntry = {
      version: '1.0.0',
      engine: '^1.0.0',
      url: 'packages/mismatch.cnlplugin',
      sha256: sha256Hex(mismatchZipBytes),
      size: mismatchZipBytes.byteLength,
      permissions: ['project:read', 'net:api.example.com'] as PluginPermission[],
      contributes: [] as ContributionKind[],
      signature: '',
    };
    mismatchEntry.signature = sign(mismatchEntry, pubKeys.privateKey);
    await expect(
      install(
        {
          plugin: { ...rawIndexJson.plugins[0]!, id: 'org.example.demo', versions: [mismatchEntry] },
          version: mismatchEntry,
          baseUrl: regDir,
        },
        { stateDir, publisherPublicKey: pubKeys.publicKey },
      ),
    ).rejects.toThrow(/does not match registry entry id/);
  });

  it('rejects zip-slip archives (../, absolute /, backslash, drive letter C:, and symlinks) before writing any file', async () => {
    const stateDir = makeTemp('cadllm-zipslip-state-');
    const pkgDir = makeTemp('cadllm-zipslip-pkgs-');
    const pubKeys = keygen();

    const validManifestBytes = Buffer.from(
      JSON.stringify({
        id: 'org.example.slip',
        name: 'Slip',
        version: '1.0.0',
        engine: '^1.0.0',
        license: 'MIT',
        permissions: [],
        contributes: {},
      }),
    );

    const buildSignedArchive = (name: string, bytes: Uint8Array) => {
      const filePath = join(pkgDir, name);
      writeFileSync(filePath, bytes);
      const entry = {
        version: '1.0.0',
        engine: '^1.0.0',
        url: pathToFileURL(filePath).href,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        permissions: [] as PluginPermission[],
        contributes: [] as ContributionKind[],
        signature: '',
      };
      entry.signature = sign(entry, pubKeys.privateKey);
      return entry;
    };

    const cases: { label: string; zip: Uint8Array; pattern: RegExp }[] = [
      {
        label: 'parent traversal ../evil.txt',
        zip: zipSync({ 'plugin.json': validManifestBytes, '../evil.txt': Buffer.from('pwn') }),
        pattern: /unsafe zip entry path/,
      },
      {
        label: 'nested traversal a/../../evil.txt',
        zip: zipSync({ 'plugin.json': validManifestBytes, 'a/../../evil.txt': Buffer.from('pwn') }),
        pattern: /unsafe zip entry path/,
      },
      {
        label: 'absolute path /etc/passwd',
        zip: zipSync({ 'plugin.json': validManifestBytes, '/etc/passwd': Buffer.from('pwn') }),
        pattern: /unsafe zip entry path/,
      },
      {
        label: 'backslash path sub\\evil.txt',
        zip: zipSync({ 'plugin.json': validManifestBytes, 'sub\\evil.txt': Buffer.from('pwn') }),
        pattern: /unsafe zip entry path/,
      },
      {
        label: 'Windows drive letter C:evil.txt',
        zip: zipSync({ 'plugin.json': validManifestBytes, 'C:evil.txt': Buffer.from('pwn') }),
        pattern: /unsafe zip entry path/,
      },
      {
        label: 'POSIX symlink mode in ZIP central directory',
        zip: patchZipCentralDirExternalAttr(
          zipSync({ 'plugin.json': validManifestBytes, 'link.txt': Buffer.from('/etc/passwd') }),
          'link.txt',
          (0o120777 << 16) >>> 0,
        ),
        pattern: /symlinks are not allowed/,
      },
    ];

    for (const [idx, c] of cases.entries()) {
      const entry = buildSignedArchive(`case-${idx}.cnlplugin`, c.zip);
      await expect(
        install(entry, { stateDir, publisherPublicKey: pubKeys.publicKey }),
        c.label,
      ).rejects.toThrow(c.pattern);
    }

    expect(existsSync(join(stateDir, 'plugins', 'org.example.slip'))).toBe(false);
    expect(existsSync(join(stateDir, 'evil.txt'))).toBe(false);
  });

  it('installs and uninstalls into CADLLM_STATE_DIR, never implies grants on install, and manages deterministic grants.json', async () => {
    const regDir = makeTemp('cadllm-reg-install-');
    const pluginDir = createSamplePluginDir(makeTemp('cadllm-plugin-install-'));
    const stateDir = makeTemp('cadllm-state-install-');
    process.env.CADLLM_STATE_DIR = stateDir;

    const regKeys = keygen();
    const pubKeys = keygen();
    writeFileSync(join(regDir, 'registry.pub'), regKeys.publicKey);
    writeFileSync(join(regDir, 'registry.dev.pem'), regKeys.privateKey);

    signPackageToIndex({
      packagePathOrBytes: pluginDir,
      publisherPrivateKey: pubKeys.privateKey,
      publisher: 'cadllm-examples',
      indexPath: regDir,
      registryPrivateKey: regKeys.privateKey,
    });

    const index = await loadIndex(pathToFileURL(join(regDir, 'index.json')).href);
    expect(verifyIndex(index, regKeys.publicKey)).toBe(true);
    const resolved = resolveVersion(index, 'org.example.demo', '^1.0.0');

    // Install WITHOUT grant option -> must NEVER grant anything automatically
    const installed = await install(resolved, { index, registryPublicKey: regKeys.publicKey });
    expect(installed.id).toBe('org.example.demo');
    expect(installed.version).toBe('1.0.0');
    expect(installed.grants).toEqual([]);
    expect(getGrants('org.example.demo')).toEqual([]);
    expect(existsSync(join(stateDir, 'grants.json'))).toBe(false);

    const listedBeforeGrant = listInstalled();
    expect(listedBeforeGrant).toHaveLength(1);
    expect(listedBeforeGrant[0]!.grants).toEqual([]);

    // Explicit grant() + revoke() + setGrants()
    expect(grant('org.example.demo', ['net:api.example.com'])).toEqual(['net:api.example.com']);
    expect(grant('org.example.demo', ['project:read'])).toEqual(['net:api.example.com', 'project:read']);

    const rawGrantsJson = JSON.parse(readFileSync(join(stateDir, 'grants.json'), 'utf8')) as Record<
      string,
      { permissions: string[]; grantedAt?: unknown }
    >;
    expect(rawGrantsJson['org.example.demo']).toEqual({
      permissions: ['net:api.example.com', 'project:read'],
    });
    expect('grantedAt' in rawGrantsJson['org.example.demo']!).toBe(false);

    expect(revoke('org.example.demo', ['net:api.example.com'])).toEqual(['project:read']);
    expect(getGrants('org.example.demo')).toEqual(['project:read']);

    expect(setGrants('org.example.demo', ['project:read', 'net:api.example.com'])).toEqual([
      'net:api.example.com',
      'project:read',
    ]);

    // Uninstall removes plugin files and cleans up grants
    expect(await uninstall('org.example.demo')).toBe(true);
    expect(listInstalled()).toEqual([]);
    expect(getGrants('org.example.demo')).toEqual([]);
  });

  it('fetches index, index.sig, and package over HTTP from a local 127.0.0.1 server with size cap and timeout checks', async () => {
    const regDir = makeTemp('cadllm-http-reg-');
    const pluginDir = createSamplePluginDir(makeTemp('cadllm-http-src-'));
    const stateDir = makeTemp('cadllm-http-state-');

    const regKeys = keygen();
    const pubKeys = keygen();
    writeFileSync(join(regDir, 'registry.pub'), regKeys.publicKey);
    writeFileSync(join(regDir, 'registry.dev.pem'), regKeys.privateKey);

    signPackageToIndex({
      packagePathOrBytes: pluginDir,
      publisherPrivateKey: pubKeys.privateKey,
      publisher: 'cadllm-examples',
      indexPath: regDir,
      registryPrivateKey: regKeys.privateKey,
    });

    // Configure trusted registry key via <stateDir>/config.json ("registryKey")
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ registryKey: regKeys.publicKey }, null, 2),
    );

    const server = createServer((req, res) => {
      const reqUrl = req.url ?? '/';
      if (reqUrl.startsWith('/hang')) {
        // Never respond to test fetch timeout
        return;
      }
      if (reqUrl.startsWith('/huge')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(50 * 1024 * 1024) });
        res.end(Buffer.alloc(1024));
        return;
      }
      const rel = reqUrl.replace(/^\/+/, '') || 'index.json';
      const filePath = join(regDir, rel);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200);
      res.end(readFileSync(filePath));
    });
    servers.push(server);

    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const index = await loadIndex(`${baseUrl}/index.json`, { stateDir });
    expect(verifyIndex(index, undefined, { stateDir })).toBe(true);

    const resolved = resolveVersion(index, 'org.example.demo');
    const installed = await install(resolved, { stateDir, index });
    expect(installed.id).toBe('org.example.demo');
    expect(installed.grants).toEqual([]);

    // Timeout and size cap enforcement against local 127.0.0.1 server
    await expect(loadIndex(`${baseUrl}/hang`, { stateDir, timeoutMs: 80 })).rejects.toThrow(/timed out|abort/i);
    await expect(loadIndex(`${baseUrl}/huge`, { stateDir, maxBytes: 1024 })).rejects.toThrow(/exceeds size limit/);

    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });
});
