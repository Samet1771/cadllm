// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { createLibrary, loadLibrary, summaryLine, type Library } from './library.ts';
export { validatePart } from './validate.ts';

export const builtinPartsDir: string = resolve(dirname(fileURLToPath(import.meta.url)), '../../../parts');
