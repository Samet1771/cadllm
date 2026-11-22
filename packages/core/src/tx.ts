// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from './errors.ts';
import { Query, pinKey } from './query.ts';
import type { Circuit, Component, Net, PartDef, PartResolver, PcbData, PcbLayer, PcbRules, PcbTrack, PcbVia } from './types.ts';
import { AUTO_NET_RE, NET_RE, REF_RE, closest, parseSI } from './util.ts';

export const DEFAULT_PCB_RULES: PcbRules = { clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 };

export interface ComponentSpec {
  ref?: string;
  part: string;
  props?: Record<string, string>;
  place?: Record<string, string>;
}

export interface ComponentPatch {
  part?: string;
  /** null deletes the prop. */
  props?: Record<string, string | null>;
  place?: Record<string, string | null>;
}

/**
 * Mutable view of a draft circuit inside a transaction. Every method validates and throws CadError
 * on failure; the Doc discards the draft if anything throws.
 */
export class Tx extends Query {
  /** Human-readable side effects worth reporting ("merged N3 into LA"). */
  readonly notes: string[] = [];

  constructor(draft: Circuit, parts: PartResolver) {
    super(draft, parts);
  }

  private nextId(prefix: string): string {
    this.circuit.seq += 1;
    return `${prefix}${this.circuit.seq}`;
  }

  private requirePart(id: string): PartDef {
    const p = this.parts.get(id);
    if (!p) throw new CadError('unknown_part', `unknown part ${id}`, 'search with find');
    return p;
  }

  private nextRef(prefix: string): string {
    for (let i = 1; ; i++) if (!this.component(`${prefix}${i}`)) return `${prefix}${i}`;
  }

  private nextNetName(): string {
    for (let i = 1; ; i++) if (!this.net(`N${i}`)) return `N${i}`;
  }

  private validateProps(part: PartDef, props: Record<string, string | null>, ref: string): void {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'footprint' && !part.props?.[k] && part.footprints?.length) {
        if (v !== null && v.trim() === '') throw new CadError('invalid', `${ref}: footprint cannot be empty`);
        continue;
      }
      const def = part.props?.[k];
      if (!def) {
        const names = Object.keys(part.props ?? {});
        throw new CadError('unknown_prop', `${ref}: ${part.id} has no prop ${k}`, names.length ? `props: ${names.join(' ')}` : `${part.id} has no props`);
      }
      if (v === null) continue;
      if (def.type === 'number' && parseSI(v) === undefined) throw new CadError('invalid', `${ref}: ${k}=${v} is not a number`, `e.g. 330, 10k, 4.7u${def.unit ? `, 5${def.unit}` : ''}`);
      if (def.type === 'enum' && def.options && !def.options.includes(v)) throw new CadError('invalid', `${ref}: ${k}=${v} is not allowed`, `options: ${def.options.join(' ')}`);
      if (def.type === 'bool' && v !== 'true' && v !== 'false') throw new CadError('invalid', `${ref}: ${k} must be true or false`);
    }
  }

  addComponent(spec: ComponentSpec): Component {
    const part = this.requirePart(spec.part);
    const ref = spec.ref ?? this.nextRef(part.refPrefix);
    if (!REF_RE.test(ref)) throw new CadError('invalid_name', `bad ref "${ref}"`, 'letters, digits, _; start with a letter');
    if (this.component(ref)) throw new CadError('duplicate_ref', `${ref} already exists`, `next free: ${this.nextRef(part.refPrefix)}`);
    const props = { ...(spec.props ?? {}) };
    this.validateProps(part, props, ref);
    for (const [k, def] of Object.entries(part.props ?? {})) if (props[k] === undefined && def.default !== undefined) props[k] = def.default;
    const comp: Component = { id: this.nextId('c'), ref, part: part.id, props, place: { ...(spec.place ?? {}) } };
    this.circuit.components[comp.id] = comp;
    this.byRef.set(ref.toUpperCase(), comp);
    return comp;
  }

  updateComponent(ref: string, patch: ComponentPatch): Component {
    const comp = this.requireComponent(ref);
    if (patch.part && patch.part !== comp.part) {
      const part = this.requirePart(patch.part);
      const lost = this.connectedPinIds(comp).filter(id => !part.pins.some(p => p.id === id));
      if (lost.length) throw new CadError('invalid', `${comp.ref}: ${part.id} has no pin ${lost.join(', ')}, which is connected`, 'disconnect those pins first');
      comp.part = part.id;
      for (const k of Object.keys(comp.props)) if (!part.props?.[k]) delete comp.props[k];
      for (const [k, def] of Object.entries(part.props ?? {})) if (comp.props[k] === undefined && def.default !== undefined) comp.props[k] = def.default;
    }
    if (patch.props) {
      this.validateProps(this.part(comp), patch.props, comp.ref);
      for (const [k, v] of Object.entries(patch.props)) if (v === null) delete comp.props[k]; else comp.props[k] = v;
    }
    if (patch.place) for (const [k, v] of Object.entries(patch.place)) if (v === null) delete comp.place[k]; else comp.place[k] = v;
    return comp;
  }

  removeComponent(ref: string): void {
    const comp = this.requireComponent(ref);
    for (const id of this.connectedPinIds(comp)) this.detach(pinKey(comp.id, id));
    delete this.circuit.components[comp.id];
    this.byRef.delete(comp.ref.toUpperCase());
    for (const k of Object.keys(this.circuit.meta)) {
      if (k.startsWith('__code:') && k.slice(7).toUpperCase() === comp.ref.toUpperCase()) {
        delete this.circuit.meta[k];
      }
    }
  }

  renameComponent(ref: string, newRef: string): void {
    const comp = this.requireComponent(ref);
    if (!REF_RE.test(newRef)) throw new CadError('invalid_name', `bad ref "${newRef}"`, 'letters, digits, _; start with a letter');
    const other = this.component(newRef);
    if (other && other !== comp) throw new CadError('duplicate_ref', `${newRef} already exists`);
    const oldRef = comp.ref;
    this.byRef.delete(oldRef.toUpperCase());
    comp.ref = newRef;
    this.byRef.set(newRef.toUpperCase(), comp);
    for (const k of Object.keys(this.circuit.meta)) {
      if (k.startsWith('__code:') && k.slice(7).toUpperCase() === oldRef.toUpperCase()) {
        const code = this.circuit.meta[k]!;
        delete this.circuit.meta[k];
        this.circuit.meta[`__code:${newRef}`] = code;
      }
    }
  }

  /**
   * Connect pins to a net, creating it if needed (auto-named when name is omitted).
   * A pin already on another net joins the two nets: auto nets (N1…) merge silently into named ones;
   * joining two different named nets is refused as a likely short.
   */
  connect(name: string | undefined, pinTokens: string[]): Net {
    if (name !== undefined && !NET_RE.test(name)) throw new CadError('invalid_name', `bad net name "${name}"`, 'letters, digits, _ + - ~');
    const pins = pinTokens.map(t => this.resolvePin(t));
    let net = name !== undefined ? this.net(name) : undefined;
    if (!net) {
      net = { id: this.nextId('n'), name: name ?? this.nextNetName(), pins: [] };
      this.circuit.nets[net.id] = net;
      this.byNetName.set(net.name.toUpperCase(), net);
    }
    for (const p of pins) {
      const cur = this.netOfPin(p.key);
      if (cur === net) continue;
      if (!cur) {
        net.pins.push(p.key);
        this.pinNet.set(p.key, net);
        continue;
      }
      net = this.join(net, cur, p.comp.ref + '.' + p.pin.name);
    }
    return net;
  }

  /** Join two nets; returns the survivor. */
  private join(a: Net, b: Net, via: string): Net {
    const aAuto = AUTO_NET_RE.test(a.name), bAuto = AUTO_NET_RE.test(b.name);
    if (!aAuto && !bAuto) {
      throw new CadError('net_short', `${via} is already on ${b.name}; connecting it to ${a.name} would join ${b.name} and ${a.name}`,
        `to merge on purpose: mv ${a.name} ${b.name} · to move the pin: -${b.name}: ${via}`);
    }
    const [keep, drop] = !aAuto ? [a, b] : !bAuto ? [b, a] : a.pins.length === 0 ? [b, a] : [a, b];
    const keepHadPins = keep.pins.length > 0, dropHadPins = drop.pins.length > 0;
    this.absorb(keep, drop);
    if (keepHadPins && dropHadPins) this.notes.push(`merged ${drop.name} into ${keep.name}`);
    else if (dropHadPins && !AUTO_NET_RE.test(keep.name)) this.notes.push(`${drop.name} is now ${keep.name}`);
    return keep;
  }

  private absorb(keep: Net, drop: Net): void {
    if (keep === drop) return;
    for (const k of drop.pins) {
      keep.pins.push(k);
      this.pinNet.set(k, keep);
    }
    drop.pins = [];
    delete this.circuit.nets[drop.id];
    this.byNetName.delete(drop.name.toUpperCase());
    if (this.circuit.pcb) {
      for (const t of this.circuit.pcb.tracks) if (t.net === drop.id) t.net = keep.id;
      for (const v of this.circuit.pcb.vias) if (v.net === drop.id) v.net = keep.id;
    }
  }

  /** Disconnect pins from the named net (each must be on it). */
  disconnect(name: string, pinTokens: string[]): void {
    const net = this.requireNet(name);
    for (const t of pinTokens) {
      const p = this.resolvePin(t);
      if (this.netOfPin(p.key) !== net) throw new CadError('invalid', `${t} is not on ${net.name}`);
      this.detach(p.key);
    }
  }

  removeNet(name: string): void {
    const net = this.requireNet(name);
    for (const k of [...net.pins]) this.pinNet.delete(k);
    delete this.circuit.nets[net.id];
    this.byNetName.delete(net.name.toUpperCase());
    this.dropPcbNet(net.id);
  }

  /** Rename a net; if newName exists the nets are merged into it (deliberate merge). */
  renameNet(name: string, newName: string): void {
    const net = this.requireNet(name);
    if (!NET_RE.test(newName)) throw new CadError('invalid_name', `bad net name "${newName}"`, 'letters, digits, _ + - ~');
    const other = this.net(newName);
    if (other && other !== net) {
      this.absorb(other, net);
      this.notes.push(`merged ${net.name} into ${other.name}`);
      return;
    }
    this.byNetName.delete(net.name.toUpperCase());
    net.name = newName;
    this.byNetName.set(newName.toUpperCase(), net);
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) delete this.circuit.meta[key]; else this.circuit.meta[key] = value;
  }

  ensurePcb(): PcbData {
    this.circuit.pcb ??= { tracks: [], vias: [] };
    return this.circuit.pcb;
  }

  setBoard(outline: [number, number][]): void {
    if (outline.length < 3) throw new CadError('invalid', 'board outline needs at least 3 points');
    for (const [x, y] of outline) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CadError('invalid', 'board outline coordinates must be finite numbers');
    }
    this.ensurePcb().board = { outline: outline.map(([x, y]) => [x, y]) };
  }

  setPcbRules(rules: Partial<PcbRules>): void {
    const next: PcbRules = { ...DEFAULT_PCB_RULES, ...this.circuit.pcb?.rules };
    for (const k of ['clearance', 'track', 'via', 'drill'] as const) {
      const v = rules[k];
      if (v === undefined) continue;
      if (!Number.isFinite(v) || v <= 0) throw new CadError('invalid', `pcb rule ${k} must be a positive number`);
      next[k] = v;
    }
    this.ensurePcb().rules = next;
  }

  addTrack(spec: { net: string; layer: PcbLayer; width?: number; points: [number, number][] }): PcbTrack {
    const net = this.requireNet(spec.net);
    if (spec.layer !== 'F' && spec.layer !== 'B') throw new CadError('invalid', `invalid PCB layer "${String(spec.layer)}"`, 'use F or B');
    const width = spec.width ?? this.circuit.pcb?.rules?.track ?? DEFAULT_PCB_RULES.track;
    if (!Number.isFinite(width) || width <= 0) throw new CadError('invalid', 'track width must be a positive number');
    if (spec.points.length < 2) throw new CadError('invalid', 'track needs at least 2 points');
    for (const [x, y] of spec.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CadError('invalid', 'track coordinates must be finite numbers');
    }
    const track: PcbTrack = { net: net.id, layer: spec.layer, width, points: spec.points.map(([x, y]) => [x, y]) };
    this.ensurePcb().tracks.push(track);
    return track;
  }

  addVia(spec: { net: string; at: [number, number]; size?: number; drill?: number }): PcbVia {
    const net = this.requireNet(spec.net);
    const rules = this.circuit.pcb?.rules ?? DEFAULT_PCB_RULES;
    const size = spec.size ?? rules.via;
    const drill = spec.drill ?? rules.drill;
    if (!Number.isFinite(size) || size <= 0) throw new CadError('invalid', 'via size must be a positive number');
    if (!Number.isFinite(drill) || drill <= 0) throw new CadError('invalid', 'via drill must be a positive number');
    if (!Number.isFinite(spec.at[0]) || !Number.isFinite(spec.at[1])) throw new CadError('invalid', 'via coordinates must be finite numbers');
    const via: PcbVia = { net: net.id, at: [spec.at[0], spec.at[1]], size, drill };
    this.ensurePcb().vias.push(via);
    return via;
  }

  removePcbCopper(netName?: string): void {
    const pcb = this.circuit.pcb;
    if (!pcb) {
      if (netName !== undefined) this.requireNet(netName);
      return;
    }
    if (netName === undefined) {
      pcb.tracks = [];
      pcb.vias = [];
      return;
    }
    const net = this.requireNet(netName);
    this.dropPcbNet(net.id);
  }

  private dropPcbNet(netId: string): void {
    const pcb = this.circuit.pcb;
    if (!pcb) return;
    pcb.tracks = pcb.tracks.filter(t => t.net !== netId);
    pcb.vias = pcb.vias.filter(v => v.net !== netId);
  }

  /** Rename either a component or a net (CNL `mv`). Components win when both exist. */
  rename(from: string, to: string): 'component' | 'net' {
    if (this.component(from)) { this.renameComponent(from, to); return 'component'; }
    if (this.net(from)) { this.renameNet(from, to); return 'net'; }
    const near = closest(from, [...Object.values(this.circuit.components).map(c => c.ref), ...Object.values(this.circuit.nets).map(n => n.name)]);
    throw new CadError('unknown_ref', `no component or net named ${from}`, near.length ? `did you mean ${near.join(', ')}?` : undefined);
  }

  private connectedPinIds(comp: Component): string[] {
    const prefix = comp.id + ':';
    return [...this.pinNet.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
  }

  private detach(key: string): void {
    const net = this.pinNet.get(key);
    if (!net) return;
    net.pins = net.pins.filter(k => k !== key);
    this.pinNet.delete(key);
    if (net.pins.length === 0) {
      delete this.circuit.nets[net.id];
      this.byNetName.delete(net.name.toUpperCase());
      this.dropPcbNet(net.id);
    }
  }
}
