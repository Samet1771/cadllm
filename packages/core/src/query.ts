// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from './errors.ts';
import type { Circuit, Component, Net, PartDef, PartResolver, PinDef, PinKey } from './types.ts';
import { closest, naturalCompare } from './util.ts';

export interface ResolvedPin {
  comp: Component;
  pin: PinDef;
  key: PinKey;
}

export const pinKey = (compId: string, pinId: string): PinKey => `${compId}:${pinId}`;

/** Read-only, indexed view of a circuit. Lookups by ref and net name are case-insensitive. */
export class Query {
  readonly circuit: Circuit;
  readonly parts: PartResolver;
  protected byRef = new Map<string, Component>();
  protected byNetName = new Map<string, Net>();
  protected pinNet = new Map<PinKey, Net>();

  constructor(circuit: Circuit, parts: PartResolver) {
    this.circuit = circuit;
    this.parts = parts;
    for (const c of Object.values(circuit.components)) this.byRef.set(c.ref.toUpperCase(), c);
    for (const n of Object.values(circuit.nets)) {
      this.byNetName.set(n.name.toUpperCase(), n);
      for (const k of n.pins) this.pinNet.set(k, n);
    }
  }

  component(ref: string): Component | undefined {
    return this.byRef.get(ref.toUpperCase());
  }

  requireComponent(ref: string): Component {
    const c = this.component(ref);
    if (!c) {
      const near = closest(ref, this.byRefNames());
      throw new CadError('unknown_ref', `no component ${ref}`, near.length ? `did you mean ${near.join(', ')}?` : undefined);
    }
    return c;
  }

  net(name: string): Net | undefined {
    return this.byNetName.get(name.toUpperCase());
  }

  requireNet(name: string): Net {
    const n = this.net(name);
    if (!n) {
      const near = closest(name, [...this.byNetName.values()].map(x => x.name));
      throw new CadError('unknown_net', `no net ${name}`, near.length ? `did you mean ${near.join(', ')}?` : undefined);
    }
    return n;
  }

  netOfPin(key: PinKey): Net | undefined {
    return this.pinNet.get(key);
  }

  part(comp: Component): PartDef {
    const p = this.parts.get(comp.part);
    if (!p) throw new CadError('unknown_part', `${comp.ref}: part ${comp.part} is not in the library`);
    return p;
  }

  /** Resolve "R1.2", "U1.VCC", "D1.anode". Pin match: id, then name, then alias (case-insensitive). */
  resolvePin(token: string): ResolvedPin {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) throw new CadError('invalid', `bad pin reference "${token}"`, 'use REF.PIN, e.g. R1.2 or U1.VCC');
    const comp = this.requireComponent(token.slice(0, dot));
    const want = token.slice(dot + 1);
    const part = this.part(comp);
    const lw = want.toLowerCase();
    const pin = part.pins.find(p => p.id === want)
      ?? part.pins.find(p => p.name.toLowerCase() === lw)
      ?? part.pins.find(p => p.aliases?.some(a => a.toLowerCase() === lw));
    if (!pin) throw new CadError('unknown_pin', `${comp.ref} has no pin ${want}`, `pins: ${this.pinList(part)}`);
    return { comp, pin, key: pinKey(comp.id, pin.id) };
  }

  /** "1:1A 2:1B 3:1Y … 14:VCC", or "A K" when names alone are unambiguous enough. */
  pinList(part: PartDef): string {
    return part.pins.map(p => (p.name === p.id ? p.id : `${p.id}:${p.name}`)).join(' ');
  }

  /** Display label for a pin key: "U1.VCC" (name) unless the name is ambiguous within the part, then the id. */
  pinLabel(key: PinKey): string {
    const [compId, pinId] = key.split(':') as [string, string];
    const comp = this.circuit.components[compId];
    if (!comp) return key;
    const part = this.parts.get(comp.part);
    const pin = part?.pins.find(p => p.id === pinId);
    if (!part || !pin) return `${comp.ref}.${pinId}`;
    const unique = part.pins.filter(p => p.name.toLowerCase() === pin.name.toLowerCase()).length === 1;
    return `${comp.ref}.${unique ? pin.name : pin.id}`;
  }

  /** Components in natural ref order. */
  components(): Component[] {
    return Object.values(this.circuit.components).sort((a, b) => naturalCompare(a.ref, b.ref));
  }

  /** Nets in natural name order, each with pins sorted. */
  nets(): Net[] {
    return Object.values(this.circuit.nets).sort((a, b) => naturalCompare(a.name, b.name));
  }

  sortedPins(net: Net): string[] {
    return net.pins.map(k => this.pinLabel(k)).sort(naturalCompare);
  }

  private byRefNames(): string[] {
    return [...this.byRef.values()].map(c => c.ref);
  }
}
