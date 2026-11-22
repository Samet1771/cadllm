// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import { runBench } from '../src/bench.ts';

// Token budgets (FOUNDATION §4.6): raising one is a deliberate decision, not a fix.
const SCHEMA_BUDGET = 1000;
const TASK_BUDGET = 400;

describe('MCP token benchmark', () => {
  it('keeps schemas and the M0 goal tasks inside budget', async () => {
    const r = await runBench();
    expect(r.tools).toBeLessThanOrEqual(12);
    expect(r.schemaTokens).toBeLessThan(SCHEMA_BUDGET);
    for (const t of r.tasks) {
      expect(t.ok, t.transcript.join('\n')).toBe(true);
      expect(t.calls).toBeLessThanOrEqual(6);
      expect(t.inTokens + t.outTokens, t.name).toBeLessThan(TASK_BUDGET);
    }
  });
});
