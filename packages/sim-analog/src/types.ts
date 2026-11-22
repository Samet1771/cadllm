// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

/** Boltzmann constant (J/K, CODATA 2018). */
export const KB = 1.380649e-23;
/** Elementary charge (C, CODATA 2018). */
export const Q_E = 1.602176634e-19;
/** Default simulation temperature (300.15 K = 27 °C). */
export const DEFAULT_TEMP_K = 300.15;

export const DEFAULT_GMIN = 1e-12;
export const DEFAULT_VNTOL = 1e-6;
export const DEFAULT_ABSTOL = 1e-12;
export const DEFAULT_RELTOL = 1e-6;

export const SWITCH_R_ON = 0.01;
export const SWITCH_R_OFF = 1e9;
export const MIN_POT_R = 1e-3;
/** Output driver resistance (Ω) for bridged digital IC outputs ('0' / '1'). */
export const R_OUT = 50;

export type LogicLevel = '0' | '1' | 'X' | 'Z';

export const thermalVoltage = (tempK = DEFAULT_TEMP_K): number => (KB * tempK) / Q_E;

export interface DiodeParams {
  /** Saturation current (A). */
  is: number;
  /** Ideality (emission) factor. */
  n: number;
  /** Optional series resistance (Ω). */
  rs?: number;
}

export interface ZenerParams extends DiodeParams {
  /** Reverse breakdown knee current at nominal breakdown voltage (A). */
  ibv: number;
  /** Reverse breakdown emission factor. */
  nbv: number;
}

export type LedColor = 'red' | 'yellow' | 'green' | 'blue' | 'white';

/** 1N4148 Shockley model: ~0.620 V @ 1 mA, ~0.720 V @ 10 mA at 300.15 K. */
export const DIODE_1N4148: DiodeParams = { is: 6.36e-10, n: 1.68 };

/** Color-calibrated LED Shockley models targeting Vf @ 20 mA at 300.15 K. */
export const LED_MODELS: Record<LedColor, DiodeParams> = {
  red: { is: 7.38e-16, n: 2.5 },    // ~2.00 V @ 20 mA
  yellow: { is: 5.49e-16, n: 2.6 }, // ~2.10 V @ 20 mA
  green: { is: 4.16e-16, n: 2.7 },  // ~2.20 V @ 20 mA
  blue: { is: 2.69e-17, n: 3.5 },   // ~3.10 V @ 20 mA
  white: { is: 2.69e-17, n: 3.5 },  // ~3.10 V @ 20 mA
};

/** Default Zener forward and reverse-breakdown knee parameters. */
export const ZENER_BASE: ZenerParams = { is: 6.36e-10, n: 1.68, ibv: 5e-3, nbv: 1.5 };

export type NetlistElement =
  | { kind: 'R'; ref: string; a: number; b: number; resistance: number }
  | { kind: 'C'; ref: string; a: number; b: number }
  | { kind: 'L'; ref: string; a: number; b: number }
  | { kind: 'V'; ref: string; pos: number; neg: number; voltage: number }
  | { kind: 'I'; ref: string; from: number; to: number; current: number }
  | { kind: 'D'; ref: string; anode: number; cathode: number; model: DiodeParams }
  | { kind: 'DZ'; ref: string; anode: number; cathode: number; vz: number; model?: ZenerParams };

export interface NetlistInput {
  /** Reference (0 V) node index. Defaults to 0. */
  reference?: number;
  /** Optional display names for node indices in error messages. */
  nodeNames?: Record<number, string>;
  /** Optional undriven digital output labels keyed by node index for floating-net hints. */
  undrivenDrivers?: Record<number, string[]>;
  elements: NetlistElement[];
}

export interface SolveOptions {
  /** Temperature in Kelvin (default 300.15 K). */
  temp?: number;
  /** Maximum Newton-Raphson iteration budget (default 100 plain + continuation). */
  maxIter?: number;
  /** Node-to-reference minimum conductance in S (defaults to 1e-12 for nonlinear circuits, 0 for linear). */
  gmin?: number;
}

export interface OpOptions extends SolveOptions {
  /** Steady-state logic levels keyed by net name (e.g. from digital sim Trace.final). */
  logic?: Record<string, LogicLevel>;
}

export interface NetlistResult {
  v: Record<number, number>;
  i: Record<string, number>;
  converged: boolean;
  iterations: number;
  warnings: string[];
  reason?: string;
}

export interface OpResult {
  v: Record<string, number>;
  i: Record<string, number>;
  converged: boolean;
  iterations: number;
  reference: string;
  warnings: string[];
  reason?: string;
}
