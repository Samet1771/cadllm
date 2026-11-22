// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { View } from '../types.ts';
import { autoPlace } from './autoplace.ts';
import { bbHoleAt, bbHolePos } from './board.ts';
import { analyzeBreadboard } from './connect.ts';
import { renderBreadboard } from './render.ts';

export const breadboard: View = {
  id: 'bb',
  render: renderBreadboard,
  autoPlace,
  check: q => analyzeBreadboard(q).issues,
};

export { bbHoleAt, bbHolePos };
