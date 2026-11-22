// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { ChangeSource, Delta } from '@cadllm/core';
import type { ChangedNotification } from './types.ts';

/** Convert a transaction Delta into RenderOptions.highlight entries (refs and `net:NAME`). */
export function deltaToHighlight(delta: Delta): string[] {
  const items: string[] = [
    ...delta.added,
    ...delta.changed,
    ...delta.renamed.map(([, to]) => to),
    ...delta.netsAdded.map(n => `net:${n}`),
    ...delta.netsChanged.map(n => `net:${n}`),
    ...delta.netsRenamed.map(([, to]) => `net:${to}`),
    ...delta.pcbNets.map(n => `net:${n}`),
  ];
  return [...new Set(items)];
}

export function sourceDisplayName(source: ChangeSource): string {
  switch (source) {
    case 'ai':
      return 'AI';
    case 'plugin':
      return 'Plugin';
    case 'system':
      return 'System';
    case 'user':
      return 'User';
  }
}

/** Compact human-readable fallback summary when notification.summary is empty. */
export function formatDeltaFallback(delta: Delta): string {
  const parts: string[] = [];
  for (const r of delta.added) parts.push(`+${r}`);
  for (const r of delta.removed) parts.push(`-${r}`);
  for (const r of delta.changed) parts.push(`~${r}`);
  for (const [a, b] of delta.renamed) parts.push(`${a}>${b}`);
  for (const n of delta.netsAdded) parts.push(`+${n}`);
  for (const n of delta.netsRemoved) parts.push(`-${n}`);
  for (const n of delta.netsChanged) parts.push(`~${n}`);
  for (const [a, b] of delta.netsRenamed) parts.push(`${a}>${b}`);
  if (delta.pcbNets.length > 0) {
    parts.push(`pcb: ${delta.pcbNets.map(n => `~${n}`).join(' ')}`);
  }
  return parts.join(' ');
}

/** Format a toast banner for an external `changed` notification, e.g. "AI changed R1 ~LA". */
export function formatChangeToast(n: ChangedNotification): string {
  const actor = sourceDisplayName(n.source);
  const body = n.summary.trim() || formatDeltaFallback(n.delta);
  const label = n.label ? `${n.label} ` : '';
  return body ? `${actor} changed ${label}${body}`.trim() : `${actor} updated ${n.project} (rev ${n.rev})`;
}

/**
 * Disambiguates local tab edits from remote `'user'` tabs or `'ai'`/`'plugin'` edits,
 * regardless of whether the server sends the `changed` notification before or after the RPC reply.
 */
export class OwnChangeTracker {
  private readonly ownRevs = new Set<number>();
  private inFlight = 0;
  private buffered: ChangedNotification[] = [];

  beginMutation(): void {
    this.inFlight += 1;
  }

  /** Complete an in-flight mutation; returns any buffered notifications that were NOT from this tab. */
  endMutation(rev?: number): ChangedNotification[] {
    if (rev !== undefined) this.ownRevs.add(rev);
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.inFlight > 0 || this.buffered.length === 0) return [];
    const out = this.buffered.filter(n => !this.ownRevs.has(n.rev));
    this.buffered = [];
    return out;
  }

  /**
   * Process an incoming `changed` notification.
   * Returns notifications that should be toasted/highlighted as external changes right now.
   */
  onChanged(n: ChangedNotification): ChangedNotification[] {
    if (n.source !== 'user') return [n];
    if (this.ownRevs.has(n.rev)) return [];
    if (this.inFlight > 0) {
      this.buffered.push(n);
      return [];
    }
    return [n];
  }

  reset(): void {
    this.ownRevs.clear();
    this.inFlight = 0;
    this.buffered = [];
  }
}
