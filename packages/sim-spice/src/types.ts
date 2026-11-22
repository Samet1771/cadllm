// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export type SpiceSweep = 'dec' | 'oct' | 'lin';

export type SpiceAnalysis =
  | { kind: 'op' }
  | { kind: 'tran'; stop: number; step?: number; start?: number; uic?: boolean }
  | { kind: 'ac'; sweep: SpiceSweep; points: number; start: number; stop: number };

export interface SpiceNetlistOptions {
  title?: string;
  analysis?: SpiceAnalysis;
  probes?: string[];
}

export interface TranOptions {
  stop: number;
  step?: number;
  uic?: boolean;
  probes?: string[];
}

export interface AcOptions {
  sweep: SpiceSweep;
  points: number;
  start: number;
  stop: number;
  probes?: string[];
}

export interface OpSpiceOptions {
  probes?: string[];
}

export interface SpiceResult {
  vectors: Record<string, Float64Array>;
  scale: { name: 'time' | 'frequency'; values: Float64Array };
  complex?: Record<string, { re: Float64Array; im: Float64Array }>;
  log: string[];
}
