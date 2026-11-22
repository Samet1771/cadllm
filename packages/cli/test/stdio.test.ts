// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const main = resolve(import.meta.dirname, '../src/main.ts');

describe('cadllm mcp over stdio', () => {
  it('lists the tools and runs an edit + sim', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [main, 'mcp', '--standalone'], stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual(['check', 'edit', 'find', 'help', 'history', 'layout', 'part', 'project', 'read', 'render', 'sim']);
      const text = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
      expect(await text('edit', { cnl: 'BAT1 battery 5; R1 res 330; D1 led; VCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-' })).toMatch(/^ok rev=1 /);
      expect(await text('sim', { run: 'dc; expect I(D1) 8m..10m' })).toMatch(/\nPASS I\(D1\) /);
      expect(await text('edit', { cnl: 'R9 nope' })).toBe('error: line 1: unknown part nope · search with find');
    } finally {
      await client.close();
    }
  }, 20000);
});
