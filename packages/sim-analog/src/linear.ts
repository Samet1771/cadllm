// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';

/**
 * Dense linear solver A * x = b via LU factorization with scaled partial pivoting.
 * Throws a CadError naming the offending variable/row if A is singular.
 */
export function solveLinear(
  a: Float64Array,
  b: Float64Array,
  n: number,
  colLabels: string[],
  rowLabels: string[],
): Float64Array<ArrayBuffer> {
  if (n === 0) return new Float64Array(0);

  const lu = new Float64Array(a);
  const rhs = new Float64Array(b);
  const scale = new Float64Array(n);
  const rows = rowLabels.slice();

  for (let i = 0; i < n; i++) {
    let maxAbs = 0;
    const base = i * n;
    for (let j = 0; j < n; j++) {
      const v = Math.abs(lu[base + j]!);
      if (v > maxAbs) maxAbs = v;
    }
    if (maxAbs === 0 || !Number.isFinite(maxAbs)) {
      throw new CadError('invalid', `singular matrix at ${colLabels[i] ?? `col ${i}`} (row ${rows[i] ?? i})`);
    }
    scale[i] = maxAbs;
  }

  for (let k = 0; k < n; k++) {
    let bestRow = k;
    let bestRatio = -1;
    for (let i = k; i < n; i++) {
      const ratio = Math.abs(lu[i * n + k]!) / scale[i]!;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestRow = i;
      }
    }

    const pivot = lu[bestRow * n + k]!;
    if (!Number.isFinite(pivot) || pivot === 0 || Math.abs(pivot) <= 1e-15 * scale[bestRow]!) {
      throw new CadError('invalid', `singular matrix at ${colLabels[k] ?? `col ${k}`} (row ${rows[bestRow] ?? bestRow})`);
    }

    if (bestRow !== k) {
      const kBase = k * n;
      const pBase = bestRow * n;
      for (let j = k; j < n; j++) {
        const tmp = lu[kBase + j]!;
        lu[kBase + j] = lu[pBase + j]!;
        lu[pBase + j] = tmp;
      }
      const rTmp = rhs[k]!;
      rhs[k] = rhs[bestRow]!;
      rhs[bestRow] = rTmp;

      const sTmp = scale[k]!;
      scale[k] = scale[bestRow]!;
      scale[bestRow] = sTmp;

      const lTmp = rows[k]!;
      rows[k] = rows[bestRow]!;
      rows[bestRow] = lTmp;
    }

    const kBase = k * n;
    const diag = lu[kBase + k]!;
    for (let i = k + 1; i < n; i++) {
      const iBase = i * n;
      const factor = lu[iBase + k]! / diag;
      if (factor === 0) continue;
      for (let j = k + 1; j < n; j++) {
        lu[iBase + j] = lu[iBase + j]! - factor * lu[kBase + j]!;
      }
      rhs[i] = rhs[i]! - factor * rhs[k]!;
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = rhs[i]!;
    const iBase = i * n;
    for (let j = i + 1; j < n; j++) {
      sum -= lu[iBase + j]! * x[j]!;
    }
    x[i] = sum / lu[iBase + i]!;
  }
  return x;
}
