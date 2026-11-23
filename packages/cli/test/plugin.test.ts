// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGrants, listInstalled } from '@cadllm/registry';
import { afterEach, describe, expect, it } from 'vitest';
import { runPluginCli } from '../src/plugin.ts';

function createFixturePlugin(dir: string): string {
  mkdirSync(join(dir, 'parts'), { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'org.example.cli',
        name: 'CLI Demo Plugin',
        version: '1.2.0',
        summary: 'Plugin for CLI direct function tests',
        publisher: 'cadllm-examples',
        engine: '^1.0.0',
        license: 'MIT',
        permissions: ['project:read', 'project:write'],
        contributes: {
          parts: 'parts',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'parts', 'ntc.json'),
    JSON.stringify({
      id: 'ntc_10k',
      name: 'NTC 10k',
      summary: 'Thermistor',
      category: 'sensor',
      refPrefix: 'R',
      pins: [
        { id: '1', name: '1', type: 'passive' },
        { id: '2', name: '2', type: 'passive' },
      ],
    }),
  );
  return dir;
}

describe('cadllm plugin CLI (direct function calls, no real TTY)', () => {
  const tempDirs: string[] = [];
  const prevStateDir = process.env.CADLLM_STATE_DIR;

  function makeTemp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.CADLLM_STATE_DIR;
    else process.env.CADLLM_STATE_DIR = prevStateDir;
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('runs keygen, pack, sign, search, install (non-TTY vs --yes-grant), list, grant, revoke, and remove', async () => {
    const workDir = makeTemp('cadllm-cli-work-');
    const stateDir = makeTemp('cadllm-cli-state-');
    const regDir = join(workDir, 'registry');
    const srcDir = createFixturePlugin(join(workDir, 'plugin-src'));
    process.env.CADLLM_STATE_DIR = stateDir;

    const run = async (argv: string[], extraOpts: Parameters<typeof runPluginCli>[1] = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runPluginCli(argv, {
        stateDir,
        cwd: workDir,
        isTTY: false,
        stdout: line => out.push(line),
        stderr: line => err.push(line),
        ...extraOpts,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };

    // 1. keygen for registry and publisher
    const kgReg = await run(['keygen', 'registry/registry']);
    expect(kgReg.code).toBe(0);
    expect(existsSync(join(regDir, 'registry.pub'))).toBe(true);
    expect(existsSync(join(regDir, 'registry.dev.pem'))).toBe(true);

    const kgPub = await run(['keygen', 'registry/publishers/cadllm-examples']);
    expect(kgPub.code).toBe(0);
    expect(existsSync(join(regDir, 'publishers', 'cadllm-examples.pub'))).toBe(true);
    expect(existsSync(join(regDir, 'publishers', 'cadllm-examples.dev.pem'))).toBe(true);

    // Configure stateDir config.json with trusted registryKey
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ registryKey: join(regDir, 'registry.pub') }, null, 2),
    );

    // 2. pack
    const packedFile = join(workDir, 'org.example.cli-1.2.0.cnlplugin');
    const packed = await run(['pack', srcDir, '--out', packedFile]);
    expect(packed.code).toBe(0);
    expect(packed.out).toContain('packed ');
    expect(existsSync(packedFile)).toBe(true);

    // 3. sign package and update + re-sign registry index
    const signed = await run([
      'sign',
      packedFile,
      '--key',
      join(regDir, 'publishers', 'cadllm-examples.dev.pem'),
      '--publisher',
      'cadllm-examples',
      '--index',
      regDir,
      '--registry-key',
      join(regDir, 'registry.dev.pem'),
    ]);
    expect(signed.code).toBe(0);
    expect(signed.out).toContain('signed org.example.cli@1.2.0');
    expect(existsSync(join(regDir, 'index.json'))).toBe(true);
    expect(existsSync(join(regDir, 'index.sig'))).toBe(true);

    // 4. search
    const searched = await run(['search', 'cli', '--index', regDir]);
    expect(searched.code).toBe(0);
    expect(searched.out).toContain('org.example.cli@1.2.0');
    expect(searched.out).toContain('CLI Demo Plugin');

    // 5. install in non-TTY WITHOUT --yes-grant -> prints requested permissions, installs, grants NOTHING
    const installNoGrant = await run(['install', 'org.example.cli@^1.0.0', '--index', regDir]);
    expect(installNoGrant.code).toBe(0);
    expect(installNoGrant.out).toContain('requested permissions for org.example.cli@1.2.0: project:read, project:write');
    expect(installNoGrant.out).toContain('grants: none');
    expect(getGrants('org.example.cli', { stateDir })).toEqual([]);
    expect(listInstalled({ stateDir })).toHaveLength(1);

    // 6. grant & revoke via CLI
    const granted = await run(['grant', 'org.example.cli', 'project:read', 'project:write']);
    expect(granted.code).toBe(0);
    expect(getGrants('org.example.cli', { stateDir })).toEqual(['project:read', 'project:write']);

    const revoked = await run(['revoke', 'org.example.cli', 'project:write']);
    expect(revoked.code).toBe(0);
    expect(getGrants('org.example.cli', { stateDir })).toEqual(['project:read']);

    // 7. list
    const listed = await run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('org.example.cli@1.2.0');
    expect(listed.out).toContain('grants=project:read');

    // 8. remove
    const removed = await run(['remove', 'org.example.cli']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('removed org.example.cli');
    expect(listInstalled({ stateDir })).toEqual([]);
    expect(getGrants('org.example.cli', { stateDir })).toEqual([]);

    // 9. install WITH --yes-grant -> installs and grants all declared permissions
    const installYesGrant = await run(['install', 'org.example.cli', '--index', regDir, '--yes-grant']);
    expect(installYesGrant.code).toBe(0);
    expect(installYesGrant.out).toContain('grants: project:read, project:write');
    expect(getGrants('org.example.cli', { stateDir })).toEqual(['project:read', 'project:write']);
  });
});
