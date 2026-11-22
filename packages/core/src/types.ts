// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export type PinType =
  | 'passive' | 'input' | 'output' | 'bidir' | 'tristate'
  | 'power_in' | 'power_out' | 'open_collector' | 'nc';

export interface PinDef {
  /** Stable pin id, usually the physical pin number: "1", "14". */
  id: string;
  /** Primary name: "VCC", "1A", "A" (anode). */
  name: string;
  aliases?: string[];
  type?: PinType;
}

export interface PropDef {
  type: 'number' | 'string' | 'enum' | 'bool';
  /** SI unit for number props: "Ω", "F", "V", "A", "Hz". */
  unit?: string;
  default?: string;
  options?: string[];
  description?: string;
}

export interface SimModelRef {
  kind: 'logic' | 'spice' | 'mcu';
  /** Model id resolved by the simulator package. */
  ref: string;
}

export interface PartDef {
  /** Library id used in CNL: "res", "led", "74hc00". */
  id: string;
  name: string;
  /** One line shown by `find`. Keep it short. */
  summary: string;
  category: string;
  /** Reference designator prefix: "R", "U", "D". */
  refPrefix: string;
  pins: PinDef[];
  props?: Record<string, PropDef>;
  /** Prop filled by the positional value in CNL (`R1 res 330` → resistance=330). */
  valueProp?: string;
  sim?: SimModelRef[];
  footprints?: string[];
  /** Drawing family per view, resolved by @cadllm/views: { sch: "resistor", bb: "axial" }. "none" = not drawn in that view. */
  views?: { sch?: string; bb?: string };
  keywords?: string[];
  /** Source of the pinout, required for ICs and transistors. */
  datasheet?: string;
}

export interface PartResolver {
  get(id: string): PartDef | undefined;
}

export interface Component {
  /** Immutable internal id ("c7"). Never shown to AI clients. */
  id: string;
  /** Reference designator ("R1"). Unique, renameable. */
  ref: string;
  part: string;
  props: Record<string, string>;
  /** Per-view placement, raw CNL strings keyed by view: { bb: "E10", sch: "40,20" }. */
  place: Record<string, string>;
}

/** Pin key: `${componentId}:${pinId}`. Stable across ref renames. */
export type PinKey = string;

export interface Net {
  id: string;
  name: string;
  pins: PinKey[];
}

export interface Circuit {
  meta: Record<string, string>;
  /** Id sequence counter, persisted so ids stay deterministic across save/load. */
  seq: number;
  components: Record<string, Component>;
  nets: Record<string, Net>;
}

export type ChangeSource = 'ai' | 'user' | 'plugin' | 'system';

export interface Delta {
  added: string[];
  removed: string[];
  changed: string[];
  renamed: [from: string, to: string][];
  netsAdded: string[];
  netsRemoved: string[];
  netsChanged: string[];
  netsRenamed: [from: string, to: string][];
}

export interface TxInfo {
  rev: number;
  label?: string;
  source: ChangeSource;
  delta: Delta;
  notes: string[];
}
