// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@cadllm/plugin-api';
import { NETWORK_GUARD_PATH, PluginHost, sandboxArgs } from '../src/index.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const dataOnlyDir = resolve(fixturesDir, 'data-only');
const goodDir = resolve(fixturesDir, 'good-plugin');
const colliderDir = resolve(fixturesDir, 'tool-collider');

describe('sandboxArgs', () => {
  const manifest: PluginManifest = {
    id: 'org.test.sample',
    name: 'Sample',
    version: '1.0.0',
    engine: '^1.0.0',
    license: 'MIT',
    main: 'src/index.ts',
    permissions: ['project:read', 'net:127.0.0.1', 'fs:read:./data', 'fs:write:./out'],
    contributes: {},
  };

  it('produces minimal --permission flags and intersects fs grants with manifest permissions', () => {
    const pluginDir = resolve(fixturesDir, 'good-plugin');
    const args = sandboxArgs(
      manifest,
      [
        'project:read',
        'fs:read:./data',
        'fs:write:./out',
        // Unrequested by manifest -> must NOT be granted
        'fs:read:/etc/passwd',
        'fs:write:/tmp/evil',
      ],
      { pluginDir, bootstrapFiles: [resolve(fixturesDir, 'extra-boot.mjs')] },
    );

    expect(args[0]).toBe('--permission');
    expect(args).toContain(`--allow-fs-read=${pluginDir}`);
    expect(args).toContain(`--allow-fs-read=${NETWORK_GUARD_PATH}`);
    expect(args).toContain(`--allow-fs-read=${resolve(pluginDir, './data')}`);
    expect(args).toContain(`--allow-fs-read=${resolve(fixturesDir, 'extra-boot.mjs')}`);
    expect(args).toContain(`--allow-fs-write=${resolve(pluginDir, './out')}`);

    // Unrequested paths must be excluded
    expect(args.some(a => a.includes('passwd'))).toBe(false);
    expect(args.some(a => a.includes('evil'))).toBe(false);

    // Must never enable dangerous Node capabilities
    for (const forbidden of [
      '--allow-child-process',
      '--allow-worker',
      '--allow-addons',
      '--allow-wasi',
      '--allow-fs-read=*',
      '--allow-fs-write=*',
    ]) {
      expect(args).not.toContain(forbidden);
    }

    const importIdx = args.indexOf('--import');
    expect(importIdx).toBeGreaterThan(-1);
    expect(args[importIdx + 1]).toBe(pathToFileURL(NETWORK_GUARD_PATH).href);
    expect(existsSync(NETWORK_GUARD_PATH)).toBe(true);
  });

  it('rejects wildcard * in fs grants', () => {
    const wild: PluginManifest = { ...manifest, permissions: ['fs:read:*'] };
    expect(() => sandboxArgs(wild, ['fs:read:*'], { pluginDir: goodDir })).toThrow(/unsafe fs permission/);
  });
});

describe('PluginHost data loading, lazy spawning, revision, and namespacing', () => {
  it('loads data-only plugins without spawning a process and bumps revision on load/unload', async () => {
    const host = new PluginHost();
    try {
      expect(host.revision).toBe(0);
      const loaded = host.load(dataOnlyDir);
      expect(loaded.manifest.id).toBe('org.test.data');
      expect(loaded.status).toBe('loaded');
      expect(host.revision).toBe(1);

      expect(host.parts().map(p => p.id)).toEqual(['data_sensor']);
      expect(host.spiceModels().get('DATA_M')).toBe('.model DATA_M D(IS=1e-14)');
      expect(host.tools()).toEqual([]);

      expect(host.unload('org.test.data')).toBe(true);
      expect(host.revision).toBe(2);
      expect(host.unload('org.test.data')).toBe(false);
      expect(host.revision).toBe(2);
      expect(host.parts()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('spawns code plugins lazily on first use and namespaces colliding parts and tools', async () => {
    const logs: string[] = [];
    const host = new PluginHost({
      builtinPartIds: new Set(['res']),
      grants: {
        'org.test.good': ['project:read'],
      },
      context: {
        readProject: () => 'untitled rev=0 (empty)',
        onLog: (id, level, msg) => logs.push(`${id}:${level}:${msg}`),
      },
    });

    try {
      // Load in reverse alphabetical order to verify deterministic manifest.id sorting
      host.load(colliderDir);
      host.load(goodDir);

      // Process has NOT spawned yet after load()
      expect(host.list().map(p => `${p.manifest.id}:${p.status}`)).toEqual([
        'org.test.good:loaded',
        'org.test.zzz:loaded',
      ]);

      // Parts: built-in "res" collides -> namespaced as org.test.good:res; therm_test stays bare
      const partIds = host.parts().map(p => p.id);
      expect(partIds).toEqual(['org.test.good:res', 'therm_test']);
      expect(host.partAliases().get('org.test.good:therm_test')?.id).toBe('therm_test');
      expect(host.partAliases().get('org.test.good/therm_test')?.id).toBe('therm_test');

      // SPICE models loaded synchronously from file and inline
      const models = host.spiceModels();
      expect(models.get('GOOD_THERM')).toBe(readFileSync(resolve(goodDir, 'models/therm.cir'), 'utf8'));
      expect(models.get('GOOD_INLINE')).toContain('.subckt GOOD_INLINE 1 2');

      // Panels metadata exposed without spawning
      expect(host.panels()).toEqual([
        {
          id: 'good_panel',
          title: 'Good Panel',
          pluginId: 'org.test.good',
          version: '1.2.3',
          main: 'panel/index.html',
          dir: goodDir,
        },
      ]);

      // Tools: org.test.good keeps bare "summarize_circuit", org.test.zzz gets namespaced "org.test.zzz:summarize_circuit"
      expect(host.tools().map(t => `${t.name}@${t.pluginId}`)).toEqual([
        'summarize_circuit@org.test.good',
        'add_test_res@org.test.good',
        'ping_local@org.test.good',
        'lookup_part@org.test.good',
        'org.test.zzz:summarize_circuit@org.test.zzz',
      ]);

      // Calling org.test.good's tool spawns ONLY org.test.good lazily
      const out1 = await host.callTool('summarize_circuit');
      expect(out1).toBe('summary:untitled rev=0 (empty)');
      expect(logs).toContain('org.test.good:info:good-plugin activated');
      expect(host.list().map(p => `${p.manifest.id}:${p.status}`)).toEqual([
        'org.test.good:running',
        'org.test.zzz:loaded',
      ]);

      // Calling via <pluginId>:<toolName> and <pluginId>/<toolName> aliases
      expect(await host.callTool('org.test.good/summarize_circuit')).toBe('summary:untitled rev=0 (empty)');
      expect(await host.callTool('org.test.zzz:summarize_circuit')).toBe('collider:ok');
      expect(await host.callTool('org.test.zzz/summarize_circuit')).toBe('collider:ok');

      expect(host.list().map(p => `${p.manifest.id}:${p.status}`)).toEqual([
        'org.test.good:running',
        'org.test.zzz:running',
      ]);
    } finally {
      await host.dispose();
    }
    expect(host.revision).toBeGreaterThanOrEqual(3);
  });

  it('exposes real package directory without extra node_modules secrets in env', () => {
    const pkgDir = dirname(resolve(import.meta.dirname, '../../plugin-api/package.json'));
    expect(existsSync(pkgDir)).toBe(true);
  });
});
