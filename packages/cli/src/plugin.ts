// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { errorText } from '@cadllm/core';
import {
  contributedKinds,
  isValidPermission,
  validateManifest,
  type PluginPermission,
} from '@cadllm/plugin-api';
import {
  grant,
  install,
  keygen,
  listInstalled,
  loadIndex,
  pack,
  resolve as resolvePluginVersion,
  resolveStateDir,
  revoke,
  sha256Hex,
  signPackageToIndex,
  uninstall,
  verifyIndex,
  type InstalledPlugin,
  type KeyPair,
  type RegistryPluginEntry,
  type SignPackageResult,
} from '@cadllm/registry';

export const PLUGIN_USAGE = `usage:
  cadllm plugin search [query] [--index <url|dir>]
  cadllm plugin install <id[@range]> [--index <url|dir>] [--yes-grant|--yes|--grant <perms>]
  cadllm plugin list
  cadllm plugin remove <id>
  cadllm plugin grant <id> <perm...> [--revoke]
  cadllm plugin revoke <id> [perm...]
  cadllm plugin pack <dir> [--out <file.cnlplugin>|-o <file.cnlplugin>]
  cadllm plugin sign <dir|file.cnlplugin> --key <private.pem> [--publisher <id>] [--index <registry/>] [--registry-key <reg.pem>]
  cadllm plugin keygen [name] [--out <prefix>]`;

const SUBCOMMANDS = new Set([
  'search',
  'install',
  'list',
  'remove',
  'uninstall',
  'grant',
  'revoke',
  'pack',
  'sign',
  'keygen',
]);

export interface PluginCliOptions {
  stateDir?: string;
  cwd?: string;
  isTTY?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  confirm?: (question: string) => boolean | Promise<boolean>;
}

function defaultIsTTY(): boolean {
  if (process.env.VITEST) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>(res => {
    rl.question(question, answer => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      res(normalized === 'y' || normalized === 'yes');
    });
  });
}

function parsePluginSpec(spec: string): { id: string; range: string } {
  const atIdx = spec.indexOf('@');
  if (atIdx <= 0) {
    return { id: spec.trim(), range: '*' };
  }
  const id = spec.slice(0, atIdx).trim();
  const range = spec.slice(atIdx + 1).trim() || '*';
  return { id, range };
}

function splitPermissions(tokens: string[]): PluginPermission[] {
  const out: PluginPermission[] = [];
  for (const tok of tokens) {
    for (const part of tok.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!isValidPermission(trimmed)) {
        throw new Error(`invalid permission "${trimmed}"`);
      }
      if (!out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

export async function pluginSearch(
  query?: string,
  opts: PluginCliOptions & { indexUrl?: string; registryPublicKey?: string } = {},
): Promise<RegistryPluginEntry[]> {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const index = await loadIndex(opts.indexUrl, { stateDir });
  verifyIndex(index, opts.registryPublicKey, { stateDir });

  const q = query?.trim().toLowerCase() ?? '';
  const matches = [...index.plugins]
    .filter(p => {
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.publisher.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  if (matches.length === 0) {
    out('no plugins found');
    return [];
  }
  for (const p of matches) {
    const latest = p.versions[p.versions.length - 1]?.version ?? '0.0.0';
    out(`${p.id}@${latest}  ${p.name} — ${p.summary} (publisher: ${p.publisher})`);
  }
  return matches;
}

export async function pluginInstall(
  spec: string,
  opts: PluginCliOptions & {
    indexUrl?: string;
    registryPublicKey?: string;
    yesGrant?: boolean;
    grantPerms?: PluginPermission[];
  } = {},
): Promise<InstalledPlugin> {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const { id, range } = parsePluginSpec(spec);
  if (!id) throw new Error('missing plugin id');

  const index = await loadIndex(opts.indexUrl, { stateDir });
  verifyIndex(index, opts.registryPublicKey, { stateDir });
  const resolved = resolvePluginVersion(index, id, range);

  // Install never grants anything by itself.
  const installed = await install(resolved, {
    stateDir,
    index,
    registryPublicKey: opts.registryPublicKey,
  });

  const requested = installed.manifest.permissions;
  if (requested.length > 0) {
    out(`requested permissions for ${installed.id}@${installed.version}: ${requested.join(', ')}`);
    let toGrant: PluginPermission[] = [];
    if (opts.yesGrant) {
      toGrant = [...requested];
    } else if (opts.grantPerms && opts.grantPerms.length > 0) {
      for (const perm of opts.grantPerms) {
        if (!requested.includes(perm)) {
          throw new Error(`permission "${perm}" is not requested by ${installed.id}`);
        }
      }
      toGrant = [...opts.grantPerms];
    } else {
      const isTTY = opts.isTTY ?? (opts.confirm ? true : defaultIsTTY());
      if (isTTY) {
        const ask = opts.confirm ?? promptYesNo;
        const approved = await ask(`Grant permissions [${requested.join(', ')}] to ${installed.id}? [y/N] `);
        if (approved) {
          toGrant = [...requested];
        }
      }
    }

    if (toGrant.length > 0) {
      const granted = grant(installed.id, toGrant, { stateDir });
      installed.grants = granted;
      out(`installed ${installed.id}@${installed.version} (grants: ${granted.join(', ')})`);
    } else {
      out(`installed ${installed.id}@${installed.version} (grants: none)`);
    }
  } else {
    out(`installed ${installed.id}@${installed.version} (grants: none)`);
  }

  return installed;
}

export function pluginList(opts: PluginCliOptions = {}): InstalledPlugin[] {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const installed = listInstalled({ stateDir });
  if (installed.length === 0) {
    out('no plugins installed');
    return [];
  }
  for (const item of installed) {
    const kinds = contributedKinds(item.manifest).join(',') || 'none';
    const grantsText = item.grants.join(',') || 'none';
    out(`${item.id}@${item.version}  ${item.manifest.name}  grants=${grantsText}  contributes=${kinds}`);
  }
  return installed;
}

export async function pluginRemove(id: string, opts: PluginCliOptions = {}): Promise<boolean> {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const removed = await uninstall(id, { stateDir });
  if (!removed) {
    throw new Error(`plugin "${id}" is not installed`);
  }
  out(`removed ${id}`);
  return true;
}

export function pluginGrant(
  id: string,
  permissions: string[],
  opts: PluginCliOptions = {},
): PluginPermission[] {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const parsed = splitPermissions(permissions);
  if (parsed.length === 0) {
    throw new Error('at least one permission is required for grant');
  }
  const updated = grant(id, parsed, { stateDir });
  out(`granted ${id}: ${updated.join(', ') || 'none'}`);
  return updated;
}

export function pluginRevoke(
  id: string,
  permissions: string[] = [],
  opts: PluginCliOptions = {},
): PluginPermission[] {
  const out = opts.stdout ?? (line => console.log(line));
  const stateDir = resolveStateDir(opts.stateDir);
  const parsed = permissions.length > 0 ? splitPermissions(permissions) : undefined;
  const updated = revoke(id, parsed, { stateDir });
  out(`revoked ${id}: ${updated.join(', ') || 'none'}`);
  return updated;
}

export function pluginPack(
  dir: string,
  opts: PluginCliOptions & { outPath?: string } = {},
): { outPath: string; bytes: Uint8Array; sha256: string; size: number } {
  const out = opts.stdout ?? (line => console.log(line));
  const baseCwd = opts.cwd ?? process.cwd();
  const pluginDir = resolve(baseCwd, dir);
  const manifest = validateManifest(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')));
  const bytes = pack(pluginDir);
  const defaultFileName = `${manifest.id}-${manifest.version}.cnlplugin`;

  let outPath: string;
  if (opts.outPath) {
    const candidate = resolve(baseCwd, opts.outPath);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      outPath = join(candidate, defaultFileName);
    } else {
      outPath = candidate;
    }
  } else {
    outPath = resolve(baseCwd, defaultFileName);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  const sha256 = sha256Hex(bytes);
  out(`packed ${outPath} (${bytes.byteLength} bytes, sha256=${sha256})`);
  return { outPath, bytes, sha256, size: bytes.byteLength };
}

export function pluginSign(
  targetPath: string,
  opts: PluginCliOptions & {
    keyPath: string;
    publisher?: string;
    indexPath?: string;
    registryKeyPath?: string;
    url?: string;
  },
): SignPackageResult {
  const out = opts.stdout ?? (line => console.log(line));
  const baseCwd = opts.cwd ?? process.cwd();
  const resolvedTarget = resolve(baseCwd, targetPath);
  const resolveKeyArg = (k: string): string => {
    if (k.includes('-----BEGIN')) return k;
    const candidate = resolve(baseCwd, k);
    return existsSync(candidate) ? candidate : k;
  };

  const result = signPackageToIndex({
    packagePathOrBytes: resolvedTarget,
    publisherPrivateKey: resolveKeyArg(opts.keyPath),
    publisher: opts.publisher,
    indexPath: opts.indexPath ? resolve(baseCwd, opts.indexPath) : undefined,
    registryPrivateKey: opts.registryKeyPath ? resolveKeyArg(opts.registryKeyPath) : undefined,
    url: opts.url,
  });

  out(
    `signed ${result.manifest.id}@${result.versionEntry.version} (publisher=${result.publisher}, sha256=${result.versionEntry.sha256})`,
  );
  return result;
}

export function pluginKeygen(
  name?: string,
  opts: PluginCliOptions & { outPrefix?: string } = {},
): KeyPair & { pubPath?: string; privPath?: string } {
  const out = opts.stdout ?? (line => console.log(line));
  const baseCwd = opts.cwd ?? process.cwd();
  const pair = keygen();

  const targetName = opts.outPrefix ?? name;
  if (!targetName) {
    out(pair.publicKey.trim());
    out(pair.privateKey.trim());
    return pair;
  }

  let prefixPath: string;
  if (opts.outPrefix && name && opts.outPrefix !== name) {
    const outDir = resolve(baseCwd, opts.outPrefix);
    mkdirSync(outDir, { recursive: true });
    prefixPath = join(outDir, name);
  } else {
    prefixPath = resolve(baseCwd, targetName);
    mkdirSync(dirname(prefixPath), { recursive: true });
  }

  const pubPath = `${prefixPath}.pub`;
  const devPemPath = `${prefixPath}.dev.pem`;
  const keyPath = `${prefixPath}.key`;
  const pemPath = `${prefixPath}.pem`;

  writeFileSync(pubPath, pair.publicKey, 'utf8');
  writeFileSync(devPemPath, pair.privateKey, 'utf8');
  writeFileSync(keyPath, pair.privateKey, 'utf8');
  writeFileSync(pemPath, pair.privateKey, 'utf8');

  out(`generated keypair: ${pubPath}, ${devPemPath}`);
  return { ...pair, pubPath, privPath: devPemPath };
}

export async function runPluginCli(argv: string[], opts: PluginCliOptions = {}): Promise<number> {
  const errOut = opts.stderr ?? (line => console.error(line));
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    errOut(PLUGIN_USAGE);
    return sub ? 0 : 2;
  }
  if (!SUBCOMMANDS.has(sub)) {
    errOut(`error: unknown plugin subcommand "${sub}"\n${PLUGIN_USAGE}`);
    return 2;
  }

  try {
    switch (sub) {
      case 'search': {
        let query: string | undefined;
        let indexUrl: string | undefined;
        let registryPublicKey: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i]!;
          if (arg === '--index' && rest[i + 1]) {
            indexUrl = rest[++i];
          } else if (arg === '--registry-key' && rest[i + 1]) {
            registryPublicKey = rest[++i];
          } else if (!arg.startsWith('-') && query === undefined) {
            query = arg;
          } else {
            throw new Error(`unexpected argument "${arg}"`);
          }
        }
        await pluginSearch(query, { ...opts, indexUrl, registryPublicKey });
        return 0;
      }

      case 'install': {
        let spec: string | undefined;
        let indexUrl: string | undefined;
        let registryPublicKey: string | undefined;
        let yesGrant = false;
        let grantPerms: PluginPermission[] | undefined;

        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i]!;
          if (arg === '--index' && rest[i + 1]) {
            indexUrl = rest[++i];
          } else if (arg === '--registry-key' && rest[i + 1]) {
            registryPublicKey = rest[++i];
          } else if (arg === '--yes-grant' || arg === '--yes' || arg === '-y') {
            yesGrant = true;
          } else if (arg === '--grant' && rest[i + 1]) {
            grantPerms = splitPermissions([rest[++i]!]);
          } else if (!arg.startsWith('-') && spec === undefined) {
            spec = arg;
          } else {
            throw new Error(`unexpected argument "${arg}"`);
          }
        }
        if (!spec) {
          errOut(`error: install requires <id[@range]>\n${PLUGIN_USAGE}`);
          return 2;
        }
        await pluginInstall(spec, { ...opts, indexUrl, registryPublicKey, yesGrant, grantPerms });
        return 0;
      }

      case 'list': {
        pluginList(opts);
        return 0;
      }

      case 'remove':
      case 'uninstall': {
        const id = rest.find(a => !a.startsWith('-'));
        if (!id) {
          errOut(`error: ${sub} requires <id>\n${PLUGIN_USAGE}`);
          return 2;
        }
        await pluginRemove(id, opts);
        return 0;
      }

      case 'grant': {
        let isRevoke = false;
        const positional: string[] = [];
        for (const arg of rest) {
          if (arg === '--revoke') isRevoke = true;
          else positional.push(arg);
        }
        const [id, ...perms] = positional;
        if (!id || (!isRevoke && perms.length === 0)) {
          errOut(`error: grant requires <id> <perm...>\n${PLUGIN_USAGE}`);
          return 2;
        }
        if (isRevoke) {
          pluginRevoke(id, perms, opts);
        } else {
          pluginGrant(id, perms, opts);
        }
        return 0;
      }

      case 'revoke': {
        const [id, ...perms] = rest.filter(a => !a.startsWith('-'));
        if (!id) {
          errOut(`error: revoke requires <id> [perm...]\n${PLUGIN_USAGE}`);
          return 2;
        }
        pluginRevoke(id, perms, opts);
        return 0;
      }

      case 'pack': {
        let dir: string | undefined;
        let outPath: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i]!;
          if ((arg === '--out' || arg === '-o') && rest[i + 1]) {
            outPath = rest[++i];
          } else if (!arg.startsWith('-') && dir === undefined) {
            dir = arg;
          } else {
            throw new Error(`unexpected argument "${arg}"`);
          }
        }
        if (!dir) {
          errOut(`error: pack requires <dir>\n${PLUGIN_USAGE}`);
          return 2;
        }
        pluginPack(dir, { ...opts, outPath });
        return 0;
      }

      case 'sign': {
        let target: string | undefined;
        let keyPath: string | undefined;
        let publisher: string | undefined;
        let indexPath: string | undefined;
        let registryKeyPath: string | undefined;
        let url: string | undefined;

        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i]!;
          if (arg === '--key' && rest[i + 1]) {
            keyPath = rest[++i];
          } else if (arg === '--publisher' && rest[i + 1]) {
            publisher = rest[++i];
          } else if (arg === '--index' && rest[i + 1]) {
            indexPath = rest[++i];
          } else if (arg === '--registry-key' && rest[i + 1]) {
            registryKeyPath = rest[++i];
          } else if (arg === '--url' && rest[i + 1]) {
            url = rest[++i];
          } else if (!arg.startsWith('-') && target === undefined) {
            target = arg;
          } else {
            throw new Error(`unexpected argument "${arg}"`);
          }
        }
        if (!target || !keyPath) {
          errOut(`error: sign requires <dir|file.cnlplugin> --key <private.pem>\n${PLUGIN_USAGE}`);
          return 2;
        }
        pluginSign(target, {
          ...opts,
          keyPath,
          publisher,
          indexPath,
          registryKeyPath,
          url,
        });
        return 0;
      }

      case 'keygen': {
        let name: string | undefined;
        let outPrefix: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i]!;
          if ((arg === '--out' || arg === '-o') && rest[i + 1]) {
            outPrefix = rest[++i];
          } else if (!arg.startsWith('-') && name === undefined) {
            name = arg;
          } else {
            throw new Error(`unexpected argument "${arg}"`);
          }
        }
        pluginKeygen(name, { ...opts, outPrefix });
        return 0;
      }
    }
  } catch (err) {
    errOut(`error: ${errorText(err)}`);
    return 1;
  }
  return 2;
}
