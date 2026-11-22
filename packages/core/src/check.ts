// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { pinKey, type Query } from './query.ts';

export interface Issue {
  level: 'error' | 'warn';
  code: 'unconnected_pin' | 'single_pin_net' | 'missing_part' | 'output_conflict' | 'no_driver';
  message: string;
  /** Refs or pin labels involved, for selection/highlighting. */
  at: string[];
}

/** Fast netlist-level checks (ERC lite). Deterministic order. */
export function basicChecks(q: Query): Issue[] {
  const issues: Issue[] = [];
  for (const comp of q.components()) {
    const part = q.parts.get(comp.part);
    if (!part) {
      issues.push({ level: 'error', code: 'missing_part', message: `${comp.ref}: part ${comp.part} not in library`, at: [comp.ref] });
      continue;
    }
    if (part.category === 'board') continue;
    const open = part.pins.filter(p => p.type !== 'nc' && !q.netOfPin(pinKey(comp.id, p.id)));
    if (open.length) {
      const labels = open.map(p => q.pinLabel(pinKey(comp.id, p.id)));
      issues.push({ level: 'warn', code: 'unconnected_pin', message: `${labels.join(' ')} unconnected`, at: labels });
    }
  }
  for (const net of q.nets()) {
    if (net.pins.length === 1) issues.push({ level: 'warn', code: 'single_pin_net', message: `net ${net.name} has only ${q.pinLabel(net.pins[0]!)}`, at: [net.name] });
    const typeOf = (k: string) => {
      const [cid, pid] = k.split(':') as [string, string];
      const comp = q.circuit.components[cid];
      return comp && q.parts.get(comp.part)?.pins.find(p => p.id === pid)?.type;
    };
    const outs = net.pins.filter(k => typeOf(k) === 'output' || typeOf(k) === 'power_out');
    if (outs.length > 1 && outs.some(k => typeOf(k) === 'output')) {
      const labels = outs.map(k => q.pinLabel(k));
      issues.push({ level: 'error', code: 'output_conflict', message: `net ${net.name}: outputs ${labels.join(' ')} drive each other`, at: labels });
    }
  }
  return issues;
}
