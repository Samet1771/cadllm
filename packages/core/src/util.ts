// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural order: R2 < R10, U1 < U1A. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const REF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export const NET_RE = /^[A-Za-z0-9_+\-~]+$/;
export const AUTO_NET_RE = /^N\d+$/;

const SI: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, meg: 1e6, M: 1e6, G: 1e9,
};

/**
 * Parse an engineering value: "330", "10k", "4.7u", "4k7", "100nF", "5V", "1meg", "2e-3".
 * Returns undefined when the string isn't a number. Note "m" is milli, "M"/"meg" is mega.
 */
export function parseSI(input: string): number | undefined {
  const s = input.trim().replace(/Ω|ohms?$/i, '');
  const pct = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*%$/);
  if (pct) return Number(pct[1]) * 0.01;
  const rkm = s.match(/^(\d+)(meg|[pnuµmkKMG])(\d+)([A-Za-z]*)$/);
  if (rkm) {
    const [, int, pre, frac] = rkm;
    return Number(`${int}.${frac}`) * SI[pre!]!;
  }
  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|[fpnuµmkKMG])?([A-Za-z]*)$/);
  if (!m) return undefined;
  return Number(m[1]) * SI[m[2] ?? '']!;
}

/** Closest candidates by edit distance, for "did you mean" hints. */
export function closest(word: string, candidates: Iterable<string>, max = 3): string[] {
  const w = word.toLowerCase();
  const scored: [string, number][] = [];
  for (const c of candidates) scored.push([c, editDistance(w, c.toLowerCase())]);
  scored.sort((a, b) => a[1] - b[1] || naturalCompare(a[0], b[0]));
  const limit = Math.max(2, Math.ceil(word.length / 2));
  return scored.filter(([, d]) => d <= limit).slice(0, max).map(([c]) => c);
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
