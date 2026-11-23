// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { runBench } from '../src/bench.ts';

// Token budgets (FOUNDATION §4.6): raising one is a deliberate decision, not a fix.
const SCHEMA_BUDGET = 1340; // 12 tools in M4 (part folded into find + ext added); measured ~1326 tok; FOUNDATION target < 2000
const TASK_BUDGET = 400;
const LAYOUT_BUDGET = 155; // measured 121 text tok + ~25% headroom; image tokens tracked separately

describe('MCP token benchmark', () => {
  it('keeps schemas and the goal tasks inside budget', async () => {
    const r = await runBench();
    expect(r.tools).toBeLessThanOrEqual(12);
    expect(r.schemaTokens).toBeLessThan(SCHEMA_BUDGET);
    expect(r.tasks.some(t => t.name === 'plugin: discover and call a plugin tool')).toBe(true);
    for (const t of r.tasks) {
      expect(t.ok, t.transcript.join('\n')).toBe(true);
      if (t.skipped) continue;
      expect(t.calls).toBeLessThanOrEqual(6);
      const budget = t.name.startsWith('layout:') ? LAYOUT_BUDGET : TASK_BUDGET;
      expect(t.inTokens + t.outTokens, t.name).toBeLessThan(budget);
    }
  }, 60_000);
});
