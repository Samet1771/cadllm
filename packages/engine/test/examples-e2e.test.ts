// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { resolve } from 'node:path';
import { errorText } from '@cadllm/core';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { compileSketch } from '@cadllm/sim-mcu';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/index.ts';

const repo = resolve(import.meta.dirname, '../../..');
const library = loadLibrary([builtinPartsDir]);

async function checkMcuReady(): Promise<string | undefined> {
  try {
    await compileSketch('void setup() {}\nvoid loop() {}');
    return undefined;
  } catch (err) {
    const msg = errorText(err);
    if (/not implemented|arduino-cli/i.test(msg)) return msg;
    throw err;
  }
}

describe('M2 examples end-to-end (cadllm test)', () => {
  it('examples/blink.cnl passes all tests', async ctx => {
    const skip = await checkMcuReady();
    if (skip) ctx.skip(skip);

    const e = new Engine({ library, root: repo });
    e.project({ op: 'open', path: 'examples/blink.cnl' });
    const res = await e.test();
    expect(res.failed, res.text).toBe(0);
    expect(res.passed).toBe(1);
    expect(res.text).toContain('PASS "blink 1s"');
  }, 30_000);

  it('examples/button-led.cnl passes all tests', async ctx => {
    const skip = await checkMcuReady();
    if (skip) ctx.skip(skip);

    const e = new Engine({ library, root: repo });
    e.project({ op: 'open', path: 'examples/button-led.cnl' });
    const res = await e.test();
    expect(res.failed, res.text).toBe(0);
    expect(res.passed).toBe(1);
    expect(res.text).toContain('PASS "button controls led"');
  }, 30_000);
});
