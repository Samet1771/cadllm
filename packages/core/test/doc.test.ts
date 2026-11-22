import { describe, expect, it } from 'vitest';
import { CadError, Doc, basicChecks, parseSI } from '../src/index.ts';
import { lib } from './fixtures.ts';

const ledCircuit = (doc: Doc) => doc.transact(tx => {
  tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5' } });
  tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' } });
  tx.addComponent({ ref: 'D1', part: 'led' });
  tx.connect('VCC', ['BAT1.+', 'R1.1']);
  tx.connect('LA', ['R1.2', 'D1.anode']);
  tx.connect('GND', ['D1.K', 'BAT1.-']);
}, { label: 'led', source: 'ai' });

const netPins = (doc: Doc, name: string) => doc.read.sortedPins(doc.read.requireNet(name));

describe('Doc transactions', () => {
  it('builds a circuit and reports the delta', () => {
    const doc = new Doc(lib);
    const info = ledCircuit(doc);
    expect(info.rev).toBe(1);
    expect(info.delta.added).toEqual(['BAT1', 'D1', 'R1']);
    expect(info.delta.netsAdded).toEqual(['GND', 'LA', 'VCC']);
    expect(netPins(doc, 'LA')).toEqual(['D1.A', 'R1.2']);
    expect(doc.read.requireComponent('D1').props.color).toBe('red');
  });

  it('is atomic: a failing step leaves the doc untouched', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    expect(() => doc.transact(tx => {
      tx.addComponent({ ref: 'R2', part: 'res' });
      tx.connect('X', ['R2.3']);
    })).toThrow(CadError);
    expect(doc.rev).toBe(1);
    expect(doc.read.component('R2')).toBeUndefined();
  });

  it('error messages carry hints', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    const msg = (fn: Parameters<Doc['transact']>[0]) => { try { doc.transact(fn); } catch (e) { return String(e); } return ''; };
    expect(msg(tx => tx.connect('VCC', ['D1.X']))).toBe('D1 has no pin X · pins: 1:A 2:K');
    expect(msg(tx => tx.connect('VCC', ['R9.1']))).toContain('no component R9');
    expect(msg(tx => tx.addComponent({ part: 'resistor' }))).toBe('unknown part resistor · search with find');
    expect(msg(tx => tx.updateComponent('D1', { props: { color: 'pink' } }))).toBe('D1: color=pink is not allowed · options: red green blue');
    expect(msg(tx => tx.updateComponent('R1', { props: { resistance: 'abc' } }))).toContain('is not a number');
  });

  it('auto-assigns refs and auto nets', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ part: 'res' });
      tx.addComponent({ part: 'res' });
      tx.connect(undefined, ['R1.2', 'R2.1']);
    });
    expect(doc.read.components().map(c => c.ref)).toEqual(['R1', 'R2']);
    expect(netPins(doc, 'N1')).toEqual(['R1.2', 'R2.1']);
  });

  it('merges an auto net into a named net when a pin joins both', () => {
    const doc = new Doc(lib);
    const info = doc.transact(tx => {
      tx.addComponent({ part: 'res' });
      tx.addComponent({ part: 'res' });
      tx.addComponent({ part: 'res' });
      tx.connect(undefined, ['R1.2', 'R2.1']);
      tx.connect('MID', ['R3.1']);
      tx.connect('MID', ['R2.1']);
    });
    expect(doc.read.net('N1')).toBeUndefined();
    expect(netPins(doc, 'MID')).toEqual(['R1.2', 'R2.1', 'R3.1']);
    expect(info.notes).toEqual(['merged N1 into MID']);
  });

  it('refuses to silently short two named nets', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    expect(() => doc.transact(tx => tx.connect('GND', ['R1.1']))).toThrow(/would join VCC and GND/);
  });

  it('mv merges nets deliberately and renames components', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    const info = doc.transact(tx => { tx.rename('LA', 'GND'); tx.rename('R1', 'R10'); });
    expect(netPins(doc, 'GND')).toEqual(['BAT1.-', 'D1.A', 'D1.K', 'R10.2']);
    expect(info.delta.renamed).toEqual([['R1', 'R10']]);
    expect(info.notes).toEqual(['merged LA into GND']);
  });

  it('removing a component disconnects it and drops empty nets', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    doc.transact(tx => { tx.removeComponent('D1'); tx.removeComponent('R1'); });
    expect(doc.read.net('LA')).toBeUndefined();
    expect(netPins(doc, 'VCC')).toEqual(['BAT1.+']);
  });

  it('changing part keeps connections when pins exist, refuses otherwise', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    expect(() => doc.transact(tx => tx.updateComponent('R1', { part: 'inv' }))).not.toThrow();
    expect(() => doc.transact(tx => tx.updateComponent('BAT1', { part: 'led' }))).not.toThrow();
  });

  it('dry run computes the delta without committing', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    const info = doc.transact(tx => tx.addComponent({ part: 'res' }), { dryRun: true });
    expect(info.delta.added).toEqual(['R2']);
    expect(doc.rev).toBe(1);
    expect(doc.read.component('R2')).toBeUndefined();
  });

  it('enforces ifRev', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    expect(() => doc.transact(tx => tx.addComponent({ part: 'res' }), { ifRev: 0 })).toThrow(/rev 1, not 0/);
  });

  it('no-op transactions do not bump the revision', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    doc.transact(() => {});
    expect(doc.rev).toBe(1);
  });
});

describe('history', () => {
  it('undo/redo restore exact states and bump revisions', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    const r1 = JSON.stringify(doc.toJSON());
    doc.transact(tx => tx.removeComponent('R1'), { label: 'rm' });
    const r2 = JSON.stringify(doc.toJSON());
    const u = doc.undo()!;
    expect(u.rev).toBe(3);
    expect(u.delta.added).toEqual(['R1']);
    expect(JSON.stringify(doc.toJSON())).toBe(r1);
    doc.redo();
    expect(JSON.stringify(doc.toJSON())).toBe(r2);
    expect(doc.canRedo).toBe(false);
  });

  it('since(rev) reports changes made after that revision', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    doc.transact(tx => tx.addComponent({ ref: 'R2', part: 'res' }));
    doc.transact(tx => tx.updateComponent('R1', { props: { resistance: '330' } }));
    const d = doc.since(1);
    expect(d.added).toEqual(['R2']);
    expect(d.changed).toEqual(['R1']);
    expect(doc.since(doc.rev).added).toEqual([]);
  });

  it('committed snapshots are never mutated', () => {
    const doc = new Doc(lib);
    ledCircuit(doc);
    const snap = doc.at(1)!.circuit;
    const before = JSON.stringify(snap);
    doc.transact(tx => { tx.removeComponent('R1'); tx.updateComponent('D1', { props: { color: 'green' } }); }, { dryRun: true });
    doc.transact(tx => { tx.removeComponent('BAT1'); tx.updateComponent('D1', { props: { color: 'green' }, place: { bb: 'E10' } }); });
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('notifies listeners', () => {
    const doc = new Doc(lib);
    const seen: number[] = [];
    doc.on(i => seen.push(i.rev));
    ledCircuit(doc);
    doc.undo();
    expect(seen).toEqual([1, 2]);
  });
});

describe('checks', () => {
  it('reports unconnected pins and output conflicts', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ part: 'inv' });
      tx.addComponent({ part: 'inv' });
      tx.addComponent({ part: 'res' });
      tx.connect('Y', ['U1.Y', 'U2.Y']);
    });
    const issues = basicChecks(doc.read).map(i => `${i.level} ${i.message}`);
    expect(issues).toEqual([
      'warn R1.1 R1.2 unconnected',
      'warn U1.A unconnected',
      'warn U2.A unconnected',
      'error net Y: outputs U1.Y U2.Y drive each other',
    ]);
  });

  it('skips unconnected_pin warnings for board parts', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ part: 'board' });
      tx.addComponent({ part: 'res' });
    });
    const issues = basicChecks(doc.read).map(i => `${i.level} ${i.message}`);
    expect(issues).toEqual(['warn R1.1 R1.2 unconnected']);
  });
});

describe('parseSI', () => {
  it.each([
    ['330', 330], ['10k', 10e3], ['4.7u', 4.7e-6], ['4k7', 4700], ['100nF', 100e-9], ['5V', 5],
    ['1meg', 1e6], ['2M', 2e6], ['3m', 3e-3], ['2e-3', 2e-3], ['220Ω', 220], ['.5', 0.5],
    ['45%', 0.45], ['100%', 1],
  ])('%s → %d', (s, v) => expect(parseSI(s)).toBeCloseTo(v, 12));

  it.each(['abc', '', 'k10', '1.2.3'])('%s is not a number', s => expect(parseSI(s)).toBeUndefined());
});

describe('__code meta lifecycle', () => {
  it('moves __code:<ref> on renameComponent and deletes it on removeComponent', () => {
    const doc = new Doc(lib);
    doc.transact(tx => {
      tx.addComponent({ ref: 'U1', part: 'inv' });
      tx.setMeta('__code:U1', 'void setup() {}');
    });
    doc.transact(tx => tx.renameComponent('U1', 'U2'));
    expect(doc.read.circuit.meta['__code:U1']).toBeUndefined();
    expect(doc.read.circuit.meta['__code:U2']).toBe('void setup() {}');

    doc.transact(tx => tx.removeComponent('U2'));
    expect(doc.read.circuit.meta['__code:U2']).toBeUndefined();
  });
});
