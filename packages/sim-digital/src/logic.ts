// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, type PartDef, type PinDef } from '@cadllm/core';
import type { Drive, Logic } from './types.ts';

/** Collapse Z inputs to X for CMOS gate evaluation. */
export const logicIn = (v: Logic): '0' | '1' | 'X' => (v === 'Z' ? 'X' : v);

export const not4 = (a: Logic): Logic => (a === '0' ? '1' : a === '1' ? '0' : 'X');

export const and4 = (a: Logic, b: Logic): Logic => {
  if (a === '0' || b === '0') return '0';
  if (a === '1' && b === '1') return '1';
  return 'X';
};

export const nand4 = (a: Logic, b: Logic): Logic => not4(and4(a, b));

export const or4 = (a: Logic, b: Logic): Logic => {
  if (a === '1' || b === '1') return '1';
  if (a === '0' && b === '0') return '0';
  return 'X';
};

export const nor4 = (a: Logic, b: Logic): Logic => not4(or4(a, b));

export const xor4 = (a: Logic, b: Logic): Logic => {
  if ((a === '0' || a === '1') && (b === '0' || b === '1')) return a !== b ? '1' : '0';
  return 'X';
};

/** Resolve strong drivers alone (ignoring weak and Z); returns 'Z' if no strong driver. */
export function resolveStrong(drives: readonly Drive[]): Logic {
  let out: Logic = 'Z';
  for (const d of drives) {
    if (d.strength !== 'strong' || d.v === 'Z') continue;
    if (d.v === 'X') return 'X';
    if (out === 'Z') out = d.v;
    else if (out !== d.v) return 'X';
  }
  return out;
}

/** Resolve all drivers on a net/supernet: strong overrides weak, all Z -> Z, disagreement -> X. */
export function resolveDrives(drives: readonly Drive[]): Logic {
  const strong = resolveStrong(drives);
  if (strong !== 'Z') return strong;
  let weak: Logic = 'Z';
  for (const d of drives) {
    if (d.strength !== 'weak' || d.v === 'Z') continue;
    if (d.v === 'X') return 'X';
    if (weak === 'Z') weak = d.v;
    else if (weak !== d.v) return 'X';
  }
  return weak;
}

/** Resolve a pin on a PartDef by primary name or alias (case-insensitive). */
export function findPin(part: PartDef, compRef: string, name: string): PinDef {
  const want = name.toLowerCase();
  const pin = part.pins.find(p => p.name.toLowerCase() === want)
    ?? part.pins.find(p => p.aliases?.some(a => a.toLowerCase() === want));
  if (!pin) throw new CadError('unknown_pin', `${compRef}: part ${part.id} has no pin ${name}`);
  return pin;
}

/** Normalize floating-point timestamps so e.g. 20n + 10n matches 30n cleanly. */
export function normalizeTime(t: number): number {
  return t === 0 ? 0 : Number(t.toPrecision(12));
}

const TIME_UNITS: readonly [number, string][] = [
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

/** Compact SI time formatter: 0 -> "0", 10e-9 -> "10n", 1.5e-6 -> "1.5u". */
export function formatTimeSI(t: number): string {
  if (t === 0) return '0';
  const abs = Math.abs(t);
  for (const [scale, prefix] of TIME_UNITS) {
    if (abs >= scale || scale === 1e-15) {
      const scaled = Number((t / scale).toPrecision(6));
      return `${scaled}${prefix}`;
    }
  }
  return String(t);
}

/** Parse a switch/button state string into closed (true) or open (false). */
export function parseSwitchState(state: string, ref?: string): boolean {
  const s = state.toLowerCase();
  if (s === 'closed' || s === 'pressed' || s === '1' || s === 'high' || s === 'true') return true;
  if (s === 'open' || s === 'released' || s === '0' || s === 'low' || s === 'false') return false;
  const who = ref ? `${ref}: ` : '';
  throw new CadError('invalid', `${who}invalid switch state "${state}"`, 'expected open|closed or released|pressed');
}
