// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadError } from '@cadllm/core';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSketch, resolveArduinoCli, Uno } from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function detectArduinoCli(): string | null {
  try {
    return resolveArduinoCli();
  } catch {
    return null;
  }
}

const CLI_PATH = detectArduinoCli();

describe('compileSketch', () => {
  const prevCli = process.env.CADLLM_ARDUINO_CLI;
  const prevState = process.env.CADLLM_STATE_DIR;
  const tempDirs: string[] = [];

  function makeStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cadllm-state-'));
    tempDirs.push(dir);
    process.env.CADLLM_STATE_DIR = dir;
    return dir;
  }

  afterEach(() => {
    if (prevCli === undefined) delete process.env.CADLLM_ARDUINO_CLI;
    else process.env.CADLLM_ARDUINO_CLI = prevCli;

    if (prevState === undefined) delete process.env.CADLLM_STATE_DIR;
    else process.env.CADLLM_STATE_DIR = prevState;

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('throws CadError with install instructions when arduino-cli is missing', async () => {
    makeStateDir();
    process.env.CADLLM_ARDUINO_CLI = join(tmpdir(), 'nonexistent-arduino-cli-bin');

    let caught: unknown;
    try {
      await compileSketch('void setup() {} void loop() {}');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CadError);
    const err = caught as CadError;
    expect(err.message).toMatch(/arduino-cli not found/i);
    expect(err.hint).toMatch(/arduino-cli/i);
  });

  it('compiles blink.ino, runs on Uno, and hits SHA-256 build cache on second compile', { timeout: 60_000 }, async (ctx) => {
    if (!CLI_PATH) {
      ctx.skip('arduino-cli not installed');
      return;
    }
    makeStateDir();
    const source = readFileSync(join(FIXTURES, 'blink.ino'), 'utf8');

    const t0 = performance.now();
    const first = await compileSketch(source);
    const coldMs = performance.now() - t0;

    expect(first.cached).toBe(false);
    expect(first.size).toBeGreaterThan(0);
    expect(first.hex).toContain(':00000001FF');

    const t1 = performance.now();
    process.env.CADLLM_ARDUINO_CLI = join(tmpdir(), 'nonexistent-arduino-cli-bin');
    const second = await compileSketch(source);
    const cachedMs = performance.now() - t1;

    expect(second.cached).toBe(true);
    expect(second.hex).toBe(first.hex);
    expect(second.size).toBe(first.size);
    expect(cachedMs).toBeLessThan(coldMs);

    const uno = new Uno(first.hex);
    const d13: string[] = [];
    uno.run(2.2, (_t, pin, level) => {
      if (pin === 'D13') d13.push(level);
    });
    expect(d13).toEqual(['0', '1', '0', '1']);
  });

  it('surfaces compiler error lines on invalid sketch', { timeout: 60_000 }, async (ctx) => {
    if (!CLI_PATH) {
      ctx.skip('arduino-cli not installed');
      return;
    }
    makeStateDir();
    const bad = 'void setup() {\n  undeclared_var = 42;\n}\nvoid loop() {}\n';

    let caught: unknown;
    try {
      await compileSketch(bad);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CadError);
    const msg = (caught as CadError).message;
    expect(msg).toMatch(/sketch\.ino:2:/);
    expect(msg).toMatch(/undeclared_var/);
  });
});
