// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';
import type { Logic } from '@cadllm/sim-digital';
import {
  adcConfig,
  AVRClock,
  AVRADC,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  avrInstruction,
  clockConfig,
  CPU,
  PinState,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';
import { parseIntelHex } from './hex.ts';

export type UnoPinName =
  | 'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7'
  | 'D8' | 'D9' | 'D10' | 'D11' | 'D12' | 'D13'
  | 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

export type UnoPinMode = 'input' | 'output' | 'input_pullup';

export interface UnoPinState {
  mode: UnoPinMode;
  level: Logic;
}

export type PinChangeHandler = (t: number, pin: UnoPinName, level: Logic) => void;

export const UNO_CLOCK_HZ = 16_000_000;
const ATMEGA328P_SRAM_BYTES = 2048;

interface PinMapping {
  name: UnoPinName;
  portIndex: 0 | 1 | 2; // 0=B, 1=C, 2=D
  bit: number;
  adcChannel: number; // -1 if none
}

const PIN_MAP: readonly PinMapping[] = [
  // Port D: D0..D7 -> PD0..PD7
  { name: 'D0', portIndex: 2, bit: 0, adcChannel: -1 },
  { name: 'D1', portIndex: 2, bit: 1, adcChannel: -1 },
  { name: 'D2', portIndex: 2, bit: 2, adcChannel: -1 },
  { name: 'D3', portIndex: 2, bit: 3, adcChannel: -1 },
  { name: 'D4', portIndex: 2, bit: 4, adcChannel: -1 },
  { name: 'D5', portIndex: 2, bit: 5, adcChannel: -1 },
  { name: 'D6', portIndex: 2, bit: 6, adcChannel: -1 },
  { name: 'D7', portIndex: 2, bit: 7, adcChannel: -1 },
  // Port B: D8..D13 -> PB0..PB5
  { name: 'D8', portIndex: 0, bit: 0, adcChannel: -1 },
  { name: 'D9', portIndex: 0, bit: 1, adcChannel: -1 },
  { name: 'D10', portIndex: 0, bit: 2, adcChannel: -1 },
  { name: 'D11', portIndex: 0, bit: 3, adcChannel: -1 },
  { name: 'D12', portIndex: 0, bit: 4, adcChannel: -1 },
  { name: 'D13', portIndex: 0, bit: 5, adcChannel: -1 },
  // Port C: A0..A5 -> PC0..PC5 / ADC0..ADC5
  { name: 'A0', portIndex: 1, bit: 0, adcChannel: 0 },
  { name: 'A1', portIndex: 1, bit: 1, adcChannel: 1 },
  { name: 'A2', portIndex: 1, bit: 2, adcChannel: 2 },
  { name: 'A3', portIndex: 1, bit: 3, adcChannel: 3 },
  { name: 'A4', portIndex: 1, bit: 4, adcChannel: 4 },
  { name: 'A5', portIndex: 1, bit: 5, adcChannel: 5 },
];

const PIN_INDEX_BY_NAME = new Map<string, number>(PIN_MAP.map((p, i) => [p.name, i]));

const PORT_PIN_INDICES: readonly (readonly number[])[] = [
  [8, 9, 10, 11, 12, 13],       // Port B: D8..D13
  [14, 15, 16, 17, 18, 19],     // Port C: A0..A5
  [0, 1, 2, 3, 4, 5, 6, 7],     // Port D: D0..D7
];

function stateToMode(state: PinState): UnoPinMode {
  if (state === PinState.InputPullUp) return 'input_pullup';
  if (state === PinState.Input) return 'input';
  return 'output';
}

function drivenLevelFor(state: PinState): Logic {
  if (state === PinState.High) return '1';
  if (state === PinState.Low) return '0';
  if (state === PinState.InputPullUp) return '1';
  return 'Z';
}

/** Cycle-accurate 16 MHz ATmega328P ("Arduino Uno") simulator backed by avr8js. */
export class Uno {
  readonly #cpu: CPU;
  readonly #ports: readonly [AVRIOPort, AVRIOPort, AVRIOPort];
  readonly #adc: AVRADC;
  readonly #inputLevels: Logic[];
  readonly #lastModes: UnoPinMode[];
  readonly #lastLevels: Logic[];
  #serial = '';
  #onPinChange: PinChangeHandler | undefined;

  constructor(hex: string) {
    const { flash } = parseIntelHex(hex);
    this.#cpu = new CPU(flash, ATMEGA328P_SRAM_BYTES);
    new AVRClock(this.#cpu, UNO_CLOCK_HZ, clockConfig);

    const portB = new AVRIOPort(this.#cpu, portBConfig);
    const portC = new AVRIOPort(this.#cpu, portCConfig);
    const portD = new AVRIOPort(this.#cpu, portDConfig);
    this.#ports = [portB, portC, portD];

    new AVRTimer(this.#cpu, timer0Config);
    new AVRTimer(this.#cpu, timer1Config);
    new AVRTimer(this.#cpu, timer2Config);

    const usart = new AVRUSART(this.#cpu, usart0Config, UNO_CLOCK_HZ);
    usart.onByteTransmit = (byte) => {
      this.#serial += String.fromCharCode(byte);
    };

    this.#adc = new AVRADC(this.#cpu, adcConfig);
    this.#inputLevels = new Array<Logic>(PIN_MAP.length).fill('Z');
    this.#lastModes = new Array<UnoPinMode>(PIN_MAP.length).fill('input');
    this.#lastLevels = new Array<Logic>(PIN_MAP.length).fill('Z');

    for (let portIdx = 0; portIdx < 3; portIdx++) {
      const port = this.#ports[portIdx]!;
      const indices = PORT_PIN_INDICES[portIdx]!;
      port.addListener(() => {
        const t = this.#cpu.cycles / UNO_CLOCK_HZ;
        for (let k = 0; k < indices.length; k++) {
          const idx = indices[k]!;
          const spec = PIN_MAP[idx]!;
          const state = port.pinState(spec.bit);
          const mode = stateToMode(state);
          const driven = drivenLevelFor(state);

          if (mode !== this.#lastModes[idx] || driven !== this.#lastLevels[idx]) {
            if (mode !== this.#lastModes[idx]) {
              this.#syncPortPin(idx);
            }
            this.#lastModes[idx] = mode;
            this.#lastLevels[idx] = driven;
            this.#onPinChange?.(t, spec.name, driven);
          }
        }
      });
    }
  }

  get serial(): string {
    return this.#serial;
  }

  get time(): number {
    return this.#cpu.cycles / UNO_CLOCK_HZ;
  }

  pin(name: UnoPinName): UnoPinState {
    const idx = this.#pinIndex(name);
    const spec = PIN_MAP[idx]!;
    const state = this.#ports[spec.portIndex]!.pinState(spec.bit);
    const mode = stateToMode(state);
    if (mode === 'output') {
      return { mode, level: state === PinState.High ? '1' : '0' };
    }
    const ext = this.#inputLevels[idx]!;
    if (mode === 'input_pullup') {
      return { mode, level: ext === 'Z' ? '1' : ext };
    }
    return { mode, level: ext };
  }

  setInput(name: UnoPinName, level: Logic | number): void {
    const idx = this.#pinIndex(name);
    const spec = PIN_MAP[idx]!;

    let logic: Logic;
    if (typeof level === 'number') {
      if (!Number.isFinite(level)) {
        throw new CadError('invalid', `invalid voltage for ${name}: ${level}`);
      }
      if (spec.adcChannel >= 0) {
        this.#adc.channelValues[spec.adcChannel] = level;
      }
      logic = level >= 2.5 ? '1' : '0';
    } else {
      if (level !== '0' && level !== '1' && level !== 'X' && level !== 'Z') {
        throw new CadError('invalid', `invalid logic level for ${name}: ${String(level)}`);
      }
      if (spec.adcChannel >= 0) {
        this.#adc.channelValues[spec.adcChannel] = level === '1' ? 5 : 0;
      }
      logic = level;
    }

    this.#inputLevels[idx] = logic;
    this.#syncPortPin(idx);
  }

  run(seconds: number, onPinChange?: PinChangeHandler): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new CadError('invalid', `invalid simulation duration: ${seconds}`);
    }
    if (seconds === 0) return;

    const targetCycles = this.#cpu.cycles + Math.round(seconds * UNO_CLOCK_HZ);
    this.#onPinChange = onPinChange;
    try {
      while (this.#cpu.cycles < targetCycles) {
        avrInstruction(this.#cpu);
        this.#cpu.tick();
      }
    } finally {
      this.#onPinChange = undefined;
    }
  }

  #pinIndex(name: UnoPinName): number {
    const idx = PIN_INDEX_BY_NAME.get(name);
    if (idx === undefined) {
      throw new CadError('unknown_pin', `unknown Uno pin ${name}`);
    }
    return idx;
  }

  #syncPortPin(idx: number): void {
    const spec = PIN_MAP[idx]!;
    const port = this.#ports[spec.portIndex]!;
    const state = port.pinState(spec.bit);
    const ext = this.#inputLevels[idx]!;
    if (state === PinState.InputPullUp) {
      port.setPin(spec.bit, ext === 'Z' || ext === 'X' ? true : ext === '1');
    } else {
      port.setPin(spec.bit, ext === '1');
    }
  }
}
