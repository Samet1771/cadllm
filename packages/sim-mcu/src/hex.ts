// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';

/** ATmega328P flash capacity: 32 KiB = 16384 16-bit instruction words. */
export const ATMEGA328P_FLASH_BYTES = 32 * 1024;
export const ATMEGA328P_FLASH_WORDS = ATMEGA328P_FLASH_BYTES / 2;

export interface ParsedHex {
  flash: Uint16Array;
  size: number;
}

/** Parse Intel HEX records into ATmega328P 16-bit little-endian program words and byte size. */
export function parseIntelHex(hex: string): ParsedHex {
  const bytes = new Uint8Array(ATMEGA328P_FLASH_BYTES);
  let upperAddr = 0;
  let size = 0;
  let sawEof = false;

  const lines = hex.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!.trim();
    if (!raw) continue;
    if (!raw.startsWith(':')) {
      throw new CadError('invalid', `invalid Intel HEX line ${idx + 1}: missing ':'`);
    }
    const payload = raw.slice(1);
    if (payload.length < 10 || payload.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(payload)) {
      throw new CadError('invalid', `invalid Intel HEX line ${idx + 1}: malformed hex record`);
    }

    const len = parseInt(payload.slice(0, 2), 16);
    if (payload.length !== (len + 5) * 2) {
      throw new CadError('invalid', `invalid Intel HEX line ${idx + 1}: length mismatch`);
    }

    let sum = 0;
    for (let i = 0; i < payload.length; i += 2) {
      sum = (sum + parseInt(payload.slice(i, i + 2), 16)) & 0xff;
    }
    if (sum !== 0) {
      throw new CadError('invalid', `invalid Intel HEX line ${idx + 1}: checksum mismatch`);
    }

    const addr = parseInt(payload.slice(2, 6), 16);
    const type = parseInt(payload.slice(6, 8), 16);

    if (type === 0x00) {
      const base = upperAddr + addr;
      if (base + len > ATMEGA328P_FLASH_BYTES) {
        throw new CadError('invalid', `firmware exceeds ATmega328P flash (${ATMEGA328P_FLASH_BYTES} bytes)`);
      }
      for (let i = 0; i < len; i++) {
        bytes[base + i] = parseInt(payload.slice(8 + i * 2, 10 + i * 2), 16);
      }
      size += len;
    } else if (type === 0x01) {
      sawEof = true;
      break;
    } else if (type === 0x02 && len === 2) {
      upperAddr = parseInt(payload.slice(8, 12), 16) << 4;
    } else if (type === 0x04 && len === 2) {
      upperAddr = parseInt(payload.slice(8, 12), 16) << 16;
    } else if (type !== 0x03 && type !== 0x05) {
      throw new CadError('invalid', `unsupported Intel HEX record type 0x${type.toString(16)}`);
    }
  }

  if (!sawEof) {
    throw new CadError('invalid', 'invalid Intel HEX: missing EOF record (:00000001FF)');
  }

  const flash = new Uint16Array(ATMEGA328P_FLASH_WORDS);
  for (let i = 0; i < ATMEGA328P_FLASH_WORDS; i++) {
    flash[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
  }
  return { flash, size };
}
