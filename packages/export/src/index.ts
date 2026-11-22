// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Query } from '@cadllm/core';
import { exportKicadPcb } from '@cadllm/kicad';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { bom, componentValue, pickAndPlace } from './assembly.ts';
import { excellon } from './excellon.ts';
import { fmtCoord, gerbers, projectName, type ExportOptions } from './gerber.ts';

export { bom, componentValue, excellon, fmtCoord, gerbers, pickAndPlace, projectName, type ExportOptions };

const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/** Bundle Gerbers, Excellon drill, BOM, and pick-and-place into a deterministic fabrication zip. */
export function fabZip(q: Query, opts?: ExportOptions): Uint8Array {
  const proj = projectName(q, opts);
  const rawFiles: Record<string, string> = {
    ...gerbers(q, opts),
    ...excellon(q, opts),
    [`${proj}-bom.csv`]: bom(q),
    [`${proj}-pnp.csv`]: pickAndPlace(q),
  };

  const zippable: Zippable = {};
  for (const name of Object.keys(rawFiles).sort((a, b) => a.localeCompare(b))) {
    zippable[name] = [strToU8(rawFiles[name]!), { mtime: FIXED_ZIP_MTIME }];
  }
  return zipSync(zippable, { mtime: FIXED_ZIP_MTIME });
}

/** Export a circuit's PCB layout to KiCad `.kicad_pcb` text. */
export function kicadPcb(q: Query): string {
  return exportKicadPcb(q);
}
