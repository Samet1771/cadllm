// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { errorText } from '@cadllm/core';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/index.ts';

const library = loadLibrary([builtinPartsDir]);
const repo = resolve(import.meta.dirname, '../../..');
const engine = (root = repo) => new Engine({ library, root });
const err = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return errorText(e); }
  throw new Error('expected an error');
};

const LED = 'BAT1 battery 5; R1 res 220; D1 led red\nVCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-';
const COUNTER = `BAT1 battery 5; U1 74hc74; SW1 button; R1 res 10k; SW2 button; R2 res 10k
VCC: BAT1.+ U1.VCC U1.1PRE U1.2PRE SW1.1 R2.2; GND: BAT1.- U1.GND R1.2 SW2.2
CLK: SW1.2 R1.1 U1.1CLK; RST: U1.1CLR U1.2CLR R2.1 SW2.1
Q0: U1.1Q; Q0N: U1.1QN U1.1D U1.2CLK; Q1: U1.2Q; Q1N: U1.2QN U1.2D`;

describe('edit and read', () => {
  it('creates an untitled project on first edit and returns a delta with issues', () => {
    const e = engine();
    expect(e.edit({ cnl: LED })).toBe('ok rev=1 +BAT1 +D1 +R1 nets: +GND +LA +VCC · 0 issues');
    expect(e.read()).toBe('untitled rev=1\nBAT1 battery 5\nD1   led     red\nR1   res     220\n\nGND: BAT1.- D1.K\nLA:  D1.A R1.2\nVCC: BAT1.+ R1.1');
    expect(e.read({ detail: 0 })).toBe('untitled rev=1 · 3 comps 3 nets · parts: battery led res');
  });

  it('reports warnings only for touched items, and errors per line', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(e.edit({ cnl: 'R2 res 1k; X: R2.1' })).toBe('ok rev=2 +R2 nets: +X · 2 warn: R2.2 unconnected; net X has only R2.1');
    expect(err(() => e.edit({ cnl: 'R5 resistor 1k\nY: D1.Q' }))).toBe(
      'line 1: unknown part resistor · search with find\nline 2: D1 has no pin Q · pins: 1:A 2:K',
    );
    expect(e.read({ detail: 0 })).toContain('rev=2');
  });

  it('supports dry_run, if_rev and since', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(e.edit({ cnl: '-R1', dry_run: true })).toBe('dry ok rev=1 unchanged -R1 nets: ~LA ~VCC');
    expect(err(() => e.edit({ cnl: '-R1', if_rev: 0 }))).toBe('document is at rev 1, not 0 · read changes with since=0');
    e.edit({ cnl: '~R1 resistance=330' });
    expect(e.read({ since: 1 })).toBe('untitled rev=2 ~R1 (since 1)\nR1 res 330');
    expect(e.read({ since: 2 })).toBe('untitled rev=2 no changes');
  });

  it('selects items and names the missing ones', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(e.read({ select: 'R1,net:LA,R9' })).toBe('untitled rev=1\nR1 res 220\n\nLA: D1.A R1.2\nnot found: R9');
  });
});

describe('sim', () => {
  it('solves dc and checks expects with enough precision near the bound', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(e.sim({ run: 'dc; expect I(D1) < 20m; expect V(LA) 1.8..2.2' })).toMatch(/^untitled rev=1 I\(D1\) 13\.\dm {2}V\(LA\) \S+\nPASS I\(D1\) 13\.\dm < 20m\nPASS V\(LA\) \S+ in 1\.8\.\.2\.2$/);
    e.edit({ cnl: '~R1 resistance=150' });
    expect(e.sim({ run: 'dc; expect I(D1) < 19m' })).toMatch(/\nFAIL I\(D1\) 20m not < 19m$/);
    expect(e.sim({ run: 'dc; expect I(D1) < 20m' })).toMatch(/\nPASS I\(D1\) 19\.9\d+m < 20m$/);
  });

  it('runs a truth table and a clocked counter', () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(e.sim({ run: 'logic in=SW1 out=Y; expect table; 0 -> 1; 1 -> 1' })).toBe('nand-led rev=0 SW1 -> Y\n0   -> 1\n1   -> 0\nFAIL table: 1 -> 0 (want 1)');
    e.project({ op: 'new', name: 'ctr' });
    e.edit({ cnl: COUNTER });
    expect(e.sim({ run: 'logic clock=SW1 reset=SW2 cycles=4 out=Q1,Q0; expect table; 0 -> 0 0; 1 -> 0 1; 2 -> 1 0; 3 -> 1 1; 4 -> 0 0' }))
      .toBe('ctr rev=1 n -> Q1 Q0\n0 -> 0  0\n1 -> 0  1\n2 -> 1  0\n3 -> 1  1\n4 -> 0  0\nPASS table 5 rows');
  });

  it('runs file tests and reports unknown analyses', () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(e.sim({ run: 'test' })).toBe('nand-led rev=0 2 tests: 2 pass\nPASS "nand truth table"\nPASS "led current"');
    expect(e.sim({ run: 'test led*' })).toBe('nand-led rev=0 1 tests: 1 pass\nPASS "led current"');
    expect(err(() => e.sim({ run: 'tran 10m' }))).toBe('tran analysis is not available yet · use dc (or op) and logic');
  });

  it('stores tests through edit and rejects bad test text', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(err(() => e.edit({ tests: 'test "x"\n  expect I(D1) <' }))).toMatch(/^line 2: cannot parse expect/);
    e.edit({ tests: 'test "cur"\n  dc\n  expect I(D1) < 20m' });
    expect(e.sim({ run: 'test' })).toBe('untitled rev=2 1 tests: 1 pass\nPASS "cur"');
    expect(e.read({ tests: true })).toContain('[tests]\ntest "cur"');
  });
});

describe('projects and history', () => {
  it('forks, merges back and undoes the merge', () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(e.project({ op: 'fork', name: 'try' })).toBe('ok project=try rev=0 (from untitled@1)');
    e.edit({ cnl: '~R1 resistance=1k' });
    expect(e.project({ op: 'merge' })).toBe('ok rev=2 ~R1 project=untitled (merged try)');
    expect(e.history({ op: 'undo' })).toBe('ok rev=3 ~R1');
    expect(e.read({ select: 'R1' })).toBe('untitled rev=3\nR1 res 220');
    expect(e.history({ op: 'log', n: 2 })).toBe('untitled rev=3\nrev 3 ai undo merge try: ~R1\nrev 2 ai merge try: ~R1');
  });

  it('saves and reopens a file exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadllm-'));
    const e = engine(dir);
    e.project({ op: 'new', name: 'led' });
    e.edit({ cnl: LED, tests: 'test "cur"\n  dc\n  expect I(D1) < 20m' });
    expect(e.project({ op: 'save' })).toBe(`ok saved ${join(dir, 'led.cnl')} led rev=1`);
    const text = readFileSync(join(dir, 'led.cnl'), 'utf8');
    expect(e.project({ op: 'open', path: 'led' })).toBe('ok project=led2 rev=0 · 3 comps 3 nets · parts: battery led res · 1 tests');
    e.project({ op: 'save' });
    expect(readFileSync(join(dir, 'led.cnl'), 'utf8')).toBe(text);
    expect(e.project({ op: 'list' })).toBe(`  led rev=1 ${join(dir, 'led.cnl')}\n* led2 rev=0 ${join(dir, 'led.cnl')}`);
  });
});

describe('library tools', () => {
  it('finds parts and describes them', () => {
    const e = engine();
    expect(e.find({ q: 'nand' }).split('\n')[0]).toMatch(/^74hc00 /);
    expect(e.part({ id: 'led' })).toBe('led  LED · light-emitting diode · ref D\npins 1:A(anode/+) · 2:K(cathode/-)\nprops color*=red (red|green|blue|yellow|white)  (* = positional value)\nsim spice:LED');
    expect(err(() => e.part({ id: 'nand' }))).toMatch(/^unknown part nand · did you mean 74hc00/);
  });

  it('help covers every topic', () => {
    const e = engine();
    for (const topic of [undefined, 'edit', 'sim', 'tests', 'project', 'examples', 'parts']) expect(e.help({ topic }).length).toBeGreaterThan(20);
    expect(err(() => e.help({ topic: 'nope' }))).toMatch(/^no help topic nope · topics:/);
  });

  it('every help example builds and simulates', () => {
    const blocks = engine().help({ topic: 'examples' }).split('\n\n');
    for (const block of blocks) {
      const e = engine();
      const lines = block.split('\n').slice(1);
      const run = lines.pop()!.replace(/^check: sim run="(.*)"$/, '$1');
      e.edit({ cnl: lines.join('\n') });
      expect(e.sim({ run }), block).not.toMatch(/FAIL|error/);
    }
  });
});
