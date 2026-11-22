// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from './errors.ts';
import { Query } from './query.ts';
import { Tx } from './tx.ts';
import type { ChangeSource, Circuit, Delta, PartResolver, TxInfo } from './types.ts';
import { naturalCompare } from './util.ts';

export interface TransactOptions {
  label?: string;
  source?: ChangeSource;
  /** Validate and compute the delta without committing. */
  dryRun?: boolean;
  /** Optimistic concurrency: fail with rev_conflict unless the doc is still at this revision. */
  ifRev?: number;
}

interface HistoryEntry {
  label?: string;
  source: ChangeSource;
  before: Circuit;
  after: Circuit;
}

export const emptyCircuit = (): Circuit => ({ meta: {}, seq: 0, components: {}, nets: {} });

const HISTORY_LIMIT = 200;

/**
 * A circuit document with revisions. Every change goes through transact(): the callback edits a draft
 * copy and the draft replaces the current circuit only if the callback completes. Committed circuits are
 * never mutated, so they double as history snapshots.
 */
export class Doc {
  readonly parts: PartResolver;
  private current: Circuit;
  private _rev = 0;
  private query: Query;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private snapshots = new Map<number, Circuit>();
  private listeners = new Set<(info: TxInfo) => void>();

  constructor(parts: PartResolver, circuit: Circuit = emptyCircuit()) {
    this.parts = parts;
    this.current = structuredClone(circuit);
    this.query = new Query(this.current, parts);
    this.snapshots.set(0, this.current);
  }

  get rev(): number {
    return this._rev;
  }

  /** Read-only indexed view of the current revision. */
  get read(): Query {
    return this.query;
  }

  toJSON(): Circuit {
    return structuredClone(this.current);
  }

  transact(fn: (tx: Tx) => void, opts: TransactOptions = {}): TxInfo {
    if (opts.ifRev !== undefined && opts.ifRev !== this._rev) {
      throw new CadError('rev_conflict', `document is at rev ${this._rev}, not ${opts.ifRev}`, `read changes with since=${opts.ifRev}`);
    }
    const draft = structuredClone(this.current);
    const tx = new Tx(draft, this.parts);
    fn(tx);
    const delta = diffCircuits(this.current, draft, this.parts);
    const source = opts.source ?? 'user';
    if (opts.dryRun) return { rev: this._rev, ...(opts.label ? { label: opts.label } : {}), source, delta, notes: tx.notes };
    if (isEmptyDelta(delta) && JSON.stringify(draft.meta) === JSON.stringify(this.current.meta)) {
      return { rev: this._rev, ...(opts.label ? { label: opts.label } : {}), source, delta, notes: tx.notes };
    }
    this.undoStack.push({ ...(opts.label ? { label: opts.label } : {}), source, before: this.current, after: draft });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    return this.commit(draft, { label: opts.label, source, delta, notes: tx.notes });
  }

  /** Replace the whole circuit as one undoable revision (fork merge, restore). Ids must be stable for a meaningful delta. */
  replace(circuit: Circuit, opts: TransactOptions = {}): TxInfo {
    return this.transact(tx => {
      const next = structuredClone(circuit);
      Object.assign(tx.circuit, next);
    }, opts);
  }

  undo(): TxInfo | undefined {
    const e = this.undoStack.pop();
    if (!e) return undefined;
    this.redoStack.push(e);
    return this.commit(e.before, { label: `undo ${e.label ?? ''}`.trim(), source: e.source, delta: diffCircuits(this.current, e.before, this.parts), notes: [] });
  }

  redo(): TxInfo | undefined {
    const e = this.redoStack.pop();
    if (!e) return undefined;
    this.undoStack.push(e);
    return this.commit(e.after, { label: `redo ${e.label ?? ''}`.trim(), source: e.source, delta: diffCircuits(this.current, e.after, this.parts), notes: [] });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** What changed between an earlier revision and now. */
  since(rev: number): Delta {
    if (rev === this._rev) return emptyDelta();
    const then = this.snapshots.get(rev);
    if (!then) throw new CadError('history', `rev ${rev} is not in history (now ${this._rev})`, 'read the full circuit instead');
    return diffCircuits(then, this.current, this.parts);
  }

  /** Query over an earlier revision (for printing removed items in deltas). */
  at(rev: number): Query | undefined {
    const c = this.snapshots.get(rev);
    return c ? new Query(c, this.parts) : undefined;
  }

  on(listener: (info: TxInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: Circuit, info: { label?: string | undefined; source: ChangeSource; delta: Delta; notes: string[] }): TxInfo {
    this.current = next;
    this._rev += 1;
    this.query = new Query(next, this.parts);
    this.snapshots.set(this._rev, next);
    if (this.snapshots.size > HISTORY_LIMIT) this.snapshots.delete(Math.min(...this.snapshots.keys()));
    const out: TxInfo = { rev: this._rev, source: info.source, delta: info.delta, notes: info.notes, ...(info.label ? { label: info.label } : {}) };
    for (const l of this.listeners) l(out);
    return out;
  }
}

export const emptyDelta = (): Delta => ({
  added: [], removed: [], changed: [], renamed: [], netsAdded: [], netsRemoved: [], netsChanged: [], netsRenamed: [],
});

export const isEmptyDelta = (d: Delta): boolean => Object.values(d).every(v => v.length === 0);

/** Structural diff by stable ids. Names in the result are refs/net names as of `b` (or `a` for removals). */
export function diffCircuits(a: Circuit, b: Circuit, _parts?: PartResolver): Delta {
  const d = emptyDelta();
  for (const [id, cb] of Object.entries(b.components)) {
    const ca = a.components[id];
    if (!ca) { d.added.push(cb.ref); continue; }
    if (ca.ref !== cb.ref) d.renamed.push([ca.ref, cb.ref]);
    if (ca.part !== cb.part || JSON.stringify(ca.props) !== JSON.stringify(cb.props) || JSON.stringify(ca.place) !== JSON.stringify(cb.place)) d.changed.push(cb.ref);
  }
  for (const [id, ca] of Object.entries(a.components)) if (!b.components[id]) d.removed.push(ca.ref);
  for (const [id, nb] of Object.entries(b.nets)) {
    const na = a.nets[id];
    if (!na) { d.netsAdded.push(nb.name); continue; }
    if (na.name !== nb.name) d.netsRenamed.push([na.name, nb.name]);
    if (na.pins.length !== nb.pins.length || [...na.pins].sort().join() !== [...nb.pins].sort().join()) d.netsChanged.push(nb.name);
  }
  for (const [id, na] of Object.entries(a.nets)) if (!b.nets[id]) d.netsRemoved.push(na.name);
  for (const list of [d.added, d.removed, d.changed, d.netsAdded, d.netsRemoved, d.netsChanged]) list.sort(naturalCompare);
  return d;
}
