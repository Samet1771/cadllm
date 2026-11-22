// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { View } from '../types.ts';

/** Schematic view (WP1). Placeholder until implemented. */
export const schematic: View = {
  id: 'sch',
  render: () => { throw new Error('schematic render: not implemented'); },
  autoPlace: () => { throw new Error('schematic autoPlace: not implemented'); },
  check: () => [],
};
