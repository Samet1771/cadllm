// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export const ONLINE_REGISTRY_URL = 'https://samet1771.github.io/cadllm/registry/';

export interface RegistryConfigResult {
  indexUrl: string;
  registryPublicKey: string;
}

/**
 * Resolve registry index URL and trusted public key without falling back to `cwd`:
 * honors `<stateDir>/config.json` and env overrides first, falling back to bundled desktop resources.
 */
export function resolveRegistryConfig(opts: {
  stateDir: string;
  defaultIndexUrl: string;
  defaultPublicKeyPath: string;
  env?: Record<string, string | undefined>;
}): RegistryConfigResult {
  const env = opts.env ?? process.env;
  let cfg: {
    registryUrl?: unknown;
    indexUrl?: unknown;
    registry?: unknown;
    registryKey?: unknown;
    registryPublicKey?: unknown;
  } = {};

  const cfgPath = join(opts.stateDir, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cfg = parsed as typeof cfg;
      }
    } catch {
      // Ignore malformed config.json and fall back to bundled defaults.
    }
  }

  const pickStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

  const indexUrl =
    pickStr(env.CADLLM_REGISTRY_URL) ??
    pickStr(cfg.registryUrl) ??
    pickStr(cfg.indexUrl) ??
    pickStr(cfg.registry) ??
    opts.defaultIndexUrl;

  const registryPublicKey =
    pickStr(env.CADLLM_REGISTRY_PUBLIC_KEY) ??
    pickStr(cfg.registryKey) ??
    pickStr(cfg.registryPublicKey) ??
    opts.defaultPublicKeyPath;

  return { indexUrl, registryPublicKey };
}

export interface DesktopResourcePaths {
  partsDir: string;
  registryDir: string;
  registryIndexPath: string;
  registryPubPath: string;
  uiDistDir: string;
  pluginRuntimeDir: string;
  networkGuardPath: string;
  pluginApiEntry: string;
  iconPath: string;
}

export interface ResolveResourcesOptions {
  isPackaged: boolean;
  resourcesPath?: string;
  repoRoot?: string;
  desktopRoot?: string;
}

/** Resolve unpacked resource paths for either packaged Electron (`resources/`) or dev monorepo layout. */
export function resolveDesktopResources(opts: ResolveResourcesOptions): DesktopResourcePaths {
  if (opts.isPackaged) {
    const resDir = resolve(opts.resourcesPath ?? process.resourcesPath);
    const pluginRuntimeDir = join(resDir, 'plugin-runtime');
    return {
      partsDir: join(resDir, 'parts'),
      registryDir: join(resDir, 'registry'),
      registryIndexPath: join(resDir, 'registry', 'index.json'),
      registryPubPath: join(resDir, 'registry', 'registry.pub'),
      uiDistDir: join(resDir, 'ui-dist'),
      pluginRuntimeDir,
      networkGuardPath: join(pluginRuntimeDir, 'guard.mjs'),
      pluginApiEntry: join(pluginRuntimeDir, 'plugin-api.mjs'),
      iconPath: join(resDir, 'icon.ico'),
    };
  }

  const repoRoot = resolve(opts.repoRoot ?? '.');
  const desktopRoot = resolve(opts.desktopRoot ?? join(repoRoot, 'packages', 'desktop'));
  const pluginRuntimeDir = join(desktopRoot, 'dist', 'plugin-runtime');
  return {
    partsDir: join(repoRoot, 'parts'),
    registryDir: join(repoRoot, 'registry'),
    registryIndexPath: join(repoRoot, 'registry', 'index.json'),
    registryPubPath: join(repoRoot, 'registry', 'registry.pub'),
    uiDistDir: join(repoRoot, 'packages', 'ui', 'dist'),
    pluginRuntimeDir,
    networkGuardPath: join(pluginRuntimeDir, 'guard.mjs'),
    pluginApiEntry: join(pluginRuntimeDir, 'plugin-api.mjs'),
    iconPath: join(desktopRoot, 'build', 'icon.ico'),
  };
}

/** Extract a `.cnl` file path passed on Electron startup or `second-instance` argv. */
export function extractCnlArg(argv: readonly string[], cwd = process.cwd()): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw || raw.startsWith('-')) continue;
    const lower = raw.toLowerCase();
    if (lower.endsWith('.exe') || lower.endsWith('main.mjs') || lower.endsWith('main.js') || lower.endsWith('main.ts')) {
      continue;
    }
    if (lower === '.' || lower.endsWith('\\desktop') || lower.endsWith('/desktop')) {
      continue;
    }
    const candidate = resolve(cwd, raw);
    if (extname(candidate).toLowerCase() === '.cnl') {
      return candidate;
    }
    if (existsSync(candidate) && candidate.toLowerCase().endsWith('.cnl')) {
      return candidate;
    }
  }
  return undefined;
}
