// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { errorText, type PartDef, type Query } from '@cadllm/core';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { PluginHost, type PluginCheckIssue, type PluginRpcContext, type PluginToolInfo } from '@cadllm/plugins';
import { describe, expect, it } from 'vitest';
import { Engine, Workspace, type WorkspaceEvent } from '../src/index.ts';

const library = loadLibrary([builtinPartsDir]);
const repo = resolve(import.meta.dirname, '../../..');
const engine = (root = repo) => new Engine({ library, root });
const err = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return errorText(e); }
  throw new Error('expected an error');
};
const errAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { return errorText(e); }
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
  it('solves dc and checks expects with enough precision near the bound', async () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(await e.sim({ run: 'dc; expect I(D1) < 20m; expect V(LA) 1.8..2.2' })).toMatch(/^untitled rev=1 I\(D1\) 13\.\dm {2}V\(LA\) \S+\nPASS I\(D1\) 13\.\dm < 20m\nPASS V\(LA\) \S+ in 1\.8\.\.2\.2$/);
    e.edit({ cnl: '~R1 resistance=150' });
    expect(await e.sim({ run: 'dc; expect I(D1) < 19m' })).toMatch(/\nFAIL I\(D1\) 20m not < 19m$/);
    expect(await e.sim({ run: 'dc; expect I(D1) < 20m' })).toMatch(/\nPASS I\(D1\) 19\.9\d+m < 20m$/);
  });

  it('runs a truth table and a clocked counter', async () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(await e.sim({ run: 'logic in=SW1 out=Y; expect table; 0 -> 1; 1 -> 1' })).toBe('nand-led rev=0 SW1 -> Y\n0   -> 1\n1   -> 0\nFAIL table: 1 -> 0 (want 1)');
    e.project({ op: 'new', name: 'ctr' });
    e.edit({ cnl: COUNTER });
    expect(await e.sim({ run: 'logic clock=SW1 reset=SW2 cycles=4 out=Q1,Q0; expect table; 0 -> 0 0; 1 -> 0 1; 2 -> 1 0; 3 -> 1 1; 4 -> 0 0' }))
      .toBe('ctr rev=1 n -> Q1 Q0\n0 -> 0  0\n1 -> 0  1\n2 -> 1  0\n3 -> 1  1\n4 -> 0  0\nPASS table 5 rows');
  });

  it('runs file tests and validates tran/ac/run inputs', async () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(await e.sim({ run: 'test' })).toBe('nand-led rev=0 2 tests: 2 pass\nPASS "nand truth table"\nPASS "led current"');
    expect(await e.sim({ run: 'test led*' })).toBe('nand-led rev=0 1 tests: 1 pass\nPASS "led current"');
    expect(await e.sim({ run: 'run 10m probes=Y' })).toBe('nand-led rev=0 t   Y\n10n 1');
    expect(await errAsync(() => e.sim({ run: 'run' }))).toMatch(/^run needs duration/);
    expect(await errAsync(() => e.sim({ run: 'tran' }))).toMatch(/^tran needs stop duration/);
    expect(await errAsync(() => e.sim({ run: 'ac dec 10 100 10' }))).toMatch(/^bad ac stop frequency/);
  });

  it('edits, reads, moves, deletes, and round-trips MCU [code] sections', () => {
    const e = engine();
    e.project({ op: 'new', name: 'uno' });
    expect(e.edit({ cnl: 'U1 arduino_uno', code: { ref: 'U1', text: 'void setup() {}\nvoid loop() {}' } }))
      .toMatch(/^ok rev=1 \+U1 · code U1/);
    expect(e.read({ code: 'U1' })).toBe('uno rev=1 [code U1]\nvoid setup() {}\nvoid loop() {}');
    e.edit({ cnl: 'mv U1 U2' });
    expect(e.read({ code: 'U2' })).toBe('uno rev=2 [code U2]\nvoid setup() {}\nvoid loop() {}');
    expect(e.edit({ code: { ref: 'U2', text: '' } })).toMatch(/^ok rev=3 · code -U2/);
    expect(e.read({ code: 'U2' })).toBe('uno rev=3 U2: no code');
  });

  it('loads and round-trips M2 blink and button-led examples via loadCircuit/saveCnl', () => {
    for (const file of ['examples/blink.cnl', 'examples/button-led.cnl']) {
      const e = engine();
      const raw = readFileSync(resolve(repo, file), 'utf8').replace(/\r\n/g, '\n');
      e.project({ op: 'open', path: file });
      expect(e.read({ code: 'U1' })).toContain('void setup()');
      const dir = mkdtempSync(join(tmpdir(), 'cadllm-ex-'));
      e.project({ op: 'save', path: join(dir, 'out.cnl') });
      expect(readFileSync(join(dir, 'out.cnl'), 'utf8')).toBe(raw);
    }
  });

  it('stores tests through edit and rejects bad test text', async () => {
    const e = engine();
    e.edit({ cnl: LED });
    expect(err(() => e.edit({ tests: 'test "x"\n  expect I(D1) <' }))).toMatch(/^line 2: cannot parse expect/);
    e.edit({ tests: 'test "cur"\n  dc\n  expect I(D1) < 20m' });
    expect(await e.sim({ run: 'test' })).toBe('untitled rev=2 1 tests: 1 pass\nPASS "cur"');
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

describe('shared workspace', () => {
  it('lets an AI and a user session co-edit one project with attribution', () => {
    const ws = new Workspace({ library, root: repo });
    const events: string[] = [];
    ws.on((e: WorkspaceEvent) => events.push(e.type === 'change' ? `${e.project}@${e.info.rev} ${e.info.source}` : `${e.type} ${e.project}`));
    const ai = new Engine({ workspace: ws, source: 'ai' });
    const user = new Engine({ workspace: ws, source: 'user' });
    ai.project({ op: 'new', name: 'led' });
    ai.edit({ cnl: LED });
    user.project({ op: 'use', name: 'led' });
    user.edit({ cnl: '~R1 resistance=330' });
    expect(ai.read({ since: 1 })).toBe('led rev=2 ~R1 (since 1)\nR1 res 330');
    expect(user.history({ op: 'undo' })).toBe('ok rev=3 ~R1');
    expect(ai.history({ op: 'log', n: 3 })).toBe('led rev=3\nrev 3 user undo: ~R1\nrev 2 user: ~R1\nrev 1 ai: +BAT1 +D1 +R1 nets: +GND +LA +VCC');
    expect(events).toEqual(['open led', 'led@1 ai', 'led@2 user', 'led@3 user']);
  });

  it('keeps a separate current project per session', () => {
    const ws = new Workspace({ library, root: repo });
    const a = new Engine({ workspace: ws });
    const b = new Engine({ workspace: ws, source: 'user' });
    a.project({ op: 'new', name: 'one' });
    b.project({ op: 'new', name: 'two' });
    a.edit({ cnl: 'R1 res 1k' });
    expect(a.projectName).toBe('one');
    expect(b.read({ detail: 0 })).toBe('two rev=0 · 0 comps 0 nets');
    b.project({ op: 'close', name: 'one' });
    expect(err(() => a.read())).toBe('project one was closed by another client · open: two · project op=use name=…');
    expect(a.project({ op: 'use', name: 'two' })).toBe('ok project=two rev=0');
  });
});

describe('views', () => {
  it('lays out both views as undoable edits and renders SVG', () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/nand-led.cnl' });
    expect(e.renderSummary('bb')).toBe('nand-led rev=0 bb: 0 parts drawn · 6 unplaced (layout view=bb)');
    expect(e.layout({ view: 'sch' })).toMatch(/^ok rev=1 placed 6 in sch: .*U1@\S+ .* · 0 issues$/);
    expect(e.layout({ view: 'bb' })).toMatch(/^ok rev=2 placed 6 in bb: .*U1@E\d+.* · 0 issues$/);
    expect(e.layout({ view: 'bb' })).toBe('nand-led rev=2 nothing to place in bb (all placed; all=true re-places)');
    expect(e.read({ select: 'U1', place: true })).toMatch(/^nand-led rev=2\nU1 74hc00 @bb:E\d+ @sch:-?\d+,-?\d+$/);
    expect(e.renderSvg({ view: 'sch' })).toMatch(/^<svg [^>]*data-view="sch"/);
    expect(e.renderSvg({ view: 'bb', highlight: ['R1'] })).toContain('data-ref="R1"');
    expect(e.renderSummary('bb')).toBe('nand-led rev=2 bb: 6 parts drawn');
    expect(e.history({ op: 'undo' })).toMatch(/^ok rev=3 ~BAT1 ~D1/);
    expect(err(() => e.layout({ view: 'nope' }))).toBe('unknown view nope · views: sch bb pcb');
  });

  it('routes PCB layout, render, check, and export tools cleanly', async () => {
    const e = engine();
    e.project({ op: 'open', path: 'examples/led-pcb.cnl' });
    expect(e.edit({ cnl: 'track VCC F 0.4 5,6 14,10' })).toMatch(/^ok rev=1 pcb: ~VCC/);
    expect(e.layout({ view: 'pcb' })).toMatch(/nothing to place in pcb/);
    expect(e.layout({ view: 'pcb', op: 'route' })).toMatch(/^ok rev=\d+ routed /);
    expect(err(() => e.layout({ view: 'sch', op: 'route' }))).toMatch(/only supported for view=pcb/);
    expect(e.renderSvg({ view: 'pcb' })).toMatch(/^<svg [^>]*data-view="pcb"/);
    expect(await e.check()).toMatch(/^led-pcb rev=2 /);

    const outDir = mkdtempSync(join(tmpdir(), 'cadllm-exp-'));
    const gbrDir = join(outDir, 'gbr');
    const drlDir = join(outDir, 'drl');
    const fabDir = join(outDir, 'fab');
    const fabZipPath = join(fabDir, 'led-pcb-fab.zip');
    const bomPath = join(outDir, 'led-pcb-bom.csv');
    const pnpPath = join(outDir, 'led-pcb-pnp.csv');
    const kicadPath = join(outDir, 'led-pcb.kicad_pcb');
    expect(e.export({ format: 'gerber', path: gbrDir })).toContain(`ok gerber ${gbrDir} · 7 gerbers · 8 pads `);
    expect(e.export({ format: 'drill', path: drlDir })).toContain(`ok drill ${drlDir} · 2 drill · 8 pads `);
    const fabOut = e.export({ format: 'fab', path: fabDir });
    expect(fabOut.split('\n')[0]).toBe(fabZipPath);
    expect(fabOut).toContain(`ok fab ${fabZipPath} · 7 gerbers 2 drill · 8 pads `);
    expect(e.export({ format: 'bom', path: bomPath })).toContain(`ok bom ${bomPath} · 4 groups · 4 parts`);
    expect(e.export({ format: 'pnp', path: pnpPath })).toContain(`ok pnp ${pnpPath} · 4 placed parts`);
    expect(e.export({ format: 'kicad', path: kicadPath })).toContain(`ok kicad ${kicadPath} · 4 parts · 8 pads `);

    e.layout({ view: 'sch' });
    const svgPath = join(outDir, 'led.svg');
    const svgOut = e.export({ format: 'svg', view: 'sch', path: svgPath });
    expect(svgOut).toContain(`ok exported svg ${svgPath}`);
    expect(readFileSync(svgPath, 'utf8')).toContain('<svg ');
  });

  it('reports breadboard shorts in check and in the edit tail', async () => {
    const e = engine();
    e.edit({ cnl: LED });
    const tail = e.edit({ cnl: 'R1 @bb:A10-A14; D1 @bb:B10-B12' });
    expect(tail).toMatch(/^ok rev=2 ~D1 ~R1 · 1 err/);
    const errs = (await e.check()).split('\n').filter(l => l.startsWith('err '));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/LA/);
    expect(errs[0]).toMatch(/VCC/);
    expect(tail).toContain(errs[0]!.slice(5));
  });
});

describe('library tools', () => {
  it('finds parts and describes them', () => {
    const e = engine();
    expect(e.find({ q: 'nand' }).split('\n')[0]).toMatch(/^74hc00 /);
    expect(e.find({ id: 'led' })).toBe('led  LED · light-emitting diode · ref D\npins 1:A(anode/+) · 2:K(cathode/-)\nprops color*=red (red|green|blue|yellow|white)  (* = positional value)\nsim spice:LED');
    expect(err(() => e.find({ id: 'nand' }))).toMatch(/^unknown part nand · did you mean 74hc00/);
  });

  it('help covers every topic', () => {
    const e = engine();
    for (const topic of [undefined, 'edit', 'sim', 'tests', 'project', 'examples', 'parts']) expect(e.help({ topic }).length).toBeGreaterThan(20);
    expect(err(() => e.help({ topic: 'nope' }))).toMatch(/^no help topic nope · topics:/);
  });

  it('every help example builds and simulates', async () => {
    const blocks = engine().help({ topic: 'examples' }).split('\n\n');
    for (const block of blocks) {
      const e = engine();
      const lines = block.split('\n').slice(1);
      const run = lines.pop()!.replace(/^check: sim run="(.*)"$/, '$1');
      e.edit({ cnl: lines.join('\n') });
      expect(await e.sim({ run }), block).not.toMatch(/FAIL|error/);
    }
  });
});

class MockPluginHost extends PluginHost {
  partsCalls = 0;
  private extraParts: PartDef[] = [];

  addPart(part: PartDef): void {
    this.extraParts.push(part);
    this.bumpRevision();
  }

  override tools(): PluginToolInfo[] {
    return [
      {
        name: 'calc_divider',
        summary: 'solve resistor divider',
        pluginId: 'org.example.sensors',
        version: '1.0.0',
      },
    ];
  }

  override async callTool(name: string, args: Record<string, unknown> = {}, ctx?: PluginRpcContext): Promise<string> {
    if (name === 'calc_divider') {
      return `R1=10k R2=20k Vin=${String(args.vin ?? 5)}`;
    }
    if (name === 'add_probe_res' && ctx?.editProject) {
      return ctx.editProject('R99 res 4k7');
    }
    return super.callTool(name, args, ctx);
  }

  override async runChecks(q: Query): Promise<PluginCheckIssue[]> {
    const hasLed = q.components().some(c => c.part === 'led');
    const hasRes = q.components().some(c => c.part === 'res');
    if (hasLed && !hasRes) {
      return [
        {
          level: 'warn',
          code: 'led_no_resistor',
          message: 'D1 has no series resistor',
          at: ['D1'],
          pluginId: 'org.example.sensors',
        },
      ];
    }
    return [];
  }

  override parts(): PartDef[] {
    this.partsCalls += 1;
    return [
      {
        id: 'ldr',
        name: 'LDR Photoresistor',
        summary: 'light-dependent resistor',
        category: 'sensor',
        refPrefix: 'R',
        pins: [
          { id: '1', name: '1', type: 'passive' },
          { id: '2', name: '2', type: 'passive' },
        ],
        props: {
          lux: { type: 'number', unit: 'lx', default: '100' },
        },
        valueProp: 'lux',
        sim: [{ kind: 'spice', ref: 'LDR' }],
        footprints: ['THT-axial'],
        views: { sch: 'resistor', bb: 'axial' },
      },
      ...this.extraParts,
    ];
  }

  override spiceModels(): Map<string, string> {
    return new Map([
      [
        'LDR',
        ['.subckt LDR 1 2 lux=100', 'R1 1 2 {10000 * (100 / lux)}', '.ends LDR'].join('\n'),
      ],
    ]);
  }
}

describe('plugins integration (find, ext, check, spiceModels)', () => {
  it('merges plugin parts, lists/calls ext tools, runs plugin checks, and simulates plugin SPICE models', async () => {
    const plugins = new MockPluginHost();
    const e = new Engine({ library, plugins, root: repo });

    // find q & id include plugin part
    expect(e.find({ q: 'ldr' })).toContain('ldr  light-dependent resistor');
    expect(e.find({ id: 'ldr' })).toContain('props lux*=100lx (number)');

    // ext list & call
    expect(await e.ext({ op: 'list' })).toBe('calc_divider  solve resistor divider  (org.example.sensors@1.0.0)');
    expect(await e.ext({ op: 'call', name: 'calc_divider', args: { vin: 12 } })).toBe('R1=10k R2=20k Vin=12');

    // plugin edit is attributed as source: 'plugin'
    expect(await e.ext({ op: 'call', name: 'add_probe_res' })).toMatch(/^ok rev=1 \+R99/);
    expect(e.history({ op: 'log', n: 1 })).toContain('rev 1 plugin: +R99');

    // check includes plugin check tagged with [org.example.sensors]
    e.project({ op: 'new', name: 'bare-led' });
    e.edit({ cnl: 'BAT1 battery 5; D1 led red\nVCC: BAT1.+ D1.A; GND: BAT1.- D1.K' });
    const chk = await e.check();
    expect(chk).toContain('warn [org.example.sensors] D1 has no series resistor');

    // dc simulation uses plugin SPICE model (.subckt LDR with lux parameter)
    e.project({ op: 'new', name: 'ldr-div' });
    e.edit({ cnl: 'V1 dc_supply 5; R1 res 10k; R2 ldr 100\nVCC: V1.+ R1.1; OUT: R1.2 R2.1; GND: V1.- R2.2' });
    expect(await e.sim({ run: 'dc; expect V(OUT) 2.4..2.6' })).toContain('PASS V(OUT)');
    e.edit({ cnl: '~R2 lux=400' });
    expect(await e.sim({ run: 'dc; expect V(OUT) 0.95..1.05' })).toContain('PASS V(OUT)');
  });

  it('caches the merged library across repeated get/search/all calls and invalidates on revision change', () => {
    const plugins = new MockPluginHost();
    const e = new Engine({ library, plugins, root: repo });
    expect(plugins.partsCalls).toBe(0);

    // First lookup builds the cache once
    expect(e.library.get('ldr')?.id).toBe('ldr');
    expect(plugins.partsCalls).toBe(1);

    // Repeated get/all/search calls hit the cache without rebuilding
    for (let i = 0; i < 50; i++) {
      expect(e.library.get('res')?.id).toBe('res');
      expect(e.library.get('ldr')?.id).toBe('ldr');
    }
    expect(e.library.all().some(p => p.id === 'ldr')).toBe(true);
    expect(e.library.search('ldr')[0]?.id).toBe('ldr');
    expect(plugins.partsCalls).toBe(1);

    // Loading a new plugin part bumps revision and invalidates the cache
    plugins.addPart({
      id: 'ntc_10k',
      name: 'NTC 10k Thermistor',
      summary: 'negative temperature coefficient thermistor',
      category: 'sensor',
      refPrefix: 'R',
      pins: [
        { id: '1', name: '1', type: 'passive' },
        { id: '2', name: '2', type: 'passive' },
      ],
    });
    expect(e.library.get('ntc_10k')?.id).toBe('ntc_10k');
    expect(plugins.partsCalls).toBe(2);

    // Subsequent calls hit the updated cache without rebuilding
    for (let i = 0; i < 20; i++) {
      expect(e.library.get('ntc_10k')?.id).toBe('ntc_10k');
    }
    expect(plugins.partsCalls).toBe(2);
  });
});
