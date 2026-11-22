// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Component, PartDef } from '@cadllm/core';

export type Logic = '0' | '1' | 'X' | 'Z';

export type Strength = 'strong' | 'weak';

export interface Drive {
  v: Logic;
  strength: Strength;
}

export interface StimulusEvent {
  t: number;
  ref: string;
  state: string;
}

export interface SimulateOptions {
  until: number;
  stimulus?: StimulusEvent[];
}

export interface TraceChange {
  t: number;
  net: string;
  v: Logic;
}

export interface Trace {
  nets: string[];
  changes: TraceChange[];
  final: Record<string, Logic>;
  settled: boolean;
  warnings: string[];
}

export interface TruthTable {
  inputs: string[];
  outputs: string[];
  rows: { in: Logic[]; out: Logic[] }[];
}

export interface ModelContext {
  readonly comp: Component;
  readonly part: PartDef;
  read(pinName: string): Logic;
  drive(pinName: string, v: Logic, strength?: Strength, delay?: number): void;
  state: Record<string, unknown>;
}

export interface LogicModel {
  /** Structural primitives handled during net resolution; omit for event-driven IC/gate models. */
  role?: 'const' | 'switch' | 'pull' | 'probe';
  /** Default propagation delay in seconds (defaults to DEFAULT_PROP_DELAY = 10 ns). */
  delay?: number;
  init?: (comp: Component, part: PartDef) => Record<string, unknown>;
  eval?: (ctx: ModelContext) => void;
}
