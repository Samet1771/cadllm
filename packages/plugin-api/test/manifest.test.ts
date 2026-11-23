// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  checkManifest,
  connect,
  contributedKinds,
  definePlugin,
  isValidSemverRange,
  PLUGIN_API_VERSION,
  satisfiesEngine,
  validateManifest,
} from '../src/index.ts';

const VALID_MANIFEST = {
  id: 'org.example.sensors',
  name: 'Example Sensor Pack',
  version: '1.2.0',
  summary: 'LDR and NTC sensors with divider calculator',
  publisher: 'example',
  engine: '^1.0.0',
  license: 'MIT',
  main: 'src/index.ts',
  permissions: ['project:read', 'project:write', 'net:api.example.com', 'net:127.0.0.1'],
  contributes: {
    parts: 'parts/',
    models: [{ id: 'LDR', kind: 'spice', file: 'models/ldr.cir' }],
    tools: [{ name: 'calc_divider', summary: 'solve resistor divider' }],
    checks: [{ id: 'led_no_resistor', summary: 'warn when LED lacks series resistor' }],
    panels: [{ id: 'sensor_panel', title: 'Sensors', main: 'panel/index.html' }],
  },
};

describe('@cadllm/plugin-api manifest validation', () => {
  it('validates a complete M4 plugin manifest and extracts contributedKinds', () => {
    const m = validateManifest(VALID_MANIFEST);
    expect(m.id).toBe('org.example.sensors');
    expect(m.permissions).toEqual(['project:read', 'project:write', 'net:api.example.com', 'net:127.0.0.1']);
    expect(contributedKinds(m)).toEqual(['checks', 'models', 'panels', 'parts', 'tools']);
    expect(checkManifest(VALID_MANIFEST)).toEqual([]);
  });

  it('rejects deferred digital models (kind: "digital") with a clear message', () => {
    const withDigital = {
      ...VALID_MANIFEST,
      contributes: {
        models: [{ id: 'dht22', kind: 'digital', main: 'dist/dht22.js' }],
      },
    };
    expect(() => validateManifest(withDigital)).toThrow(/digital.*deferred/i);
    expect(checkManifest(withDigital)[0]).toMatch(/digital.*deferred/i);
  });

  it('checks engine semver ranges against PLUGIN_API_VERSION (1.0.0-alpha.0)', () => {
    expect(PLUGIN_API_VERSION).toBe('1.0.0-alpha.0');
    expect(isValidSemverRange('^1.0.0')).toBe(true);
    expect(isValidSemverRange('>=1.0.0-alpha.0 <2.0.0')).toBe(true);
    expect(isValidSemverRange('not-a-semver')).toBe(false);

    expect(satisfiesEngine('^1.0.0')).toBe(true);
    expect(satisfiesEngine('^1.0.0-alpha.0')).toBe(true);
    expect(satisfiesEngine('>=1.0.0-alpha.0')).toBe(true);
    expect(satisfiesEngine('1.0.0-alpha.0')).toBe(true);
    expect(satisfiesEngine('1.x')).toBe(true);
    expect(satisfiesEngine('*')).toBe(true);

    expect(satisfiesEngine('^2.0.0')).toBe(false);
    expect(satisfiesEngine('>=1.1.0')).toBe(false);
    expect(satisfiesEngine('^0.9.0')).toBe(false);
    expect(satisfiesEngine('<1.0.0-alpha.0')).toBe(false);

    expect(() => validateManifest({ ...VALID_MANIFEST, engine: '^2.0.0' })).toThrow(/incompatible plugin engine range/);
  });

  it('rejects bad permissions, path traversal, and duplicate contribution ids', () => {
    expect(() =>
      validateManifest({ ...VALID_MANIFEST, permissions: ['shell:exec'] }),
    ).toThrow(/invalid permission/);

    expect(() =>
      validateManifest({ ...VALID_MANIFEST, main: '../escape.js' }),
    ).toThrow(/relative path/);

    expect(() =>
      validateManifest({
        ...VALID_MANIFEST,
        contributes: { parts: '../outside' },
      }),
    ).toThrow(/relative path/);

    expect(() =>
      validateManifest({
        ...VALID_MANIFEST,
        contributes: {
          tools: [
            { name: 'dup', summary: 'one' },
            { name: 'dup', summary: 'two' },
          ],
        },
      }),
    ).toThrow(/duplicate tools name "dup"/);
  });
});

describe('@cadllm/plugin-api definePlugin and connect over stdio', () => {
  it('routes tool/call, check/run, and capability requests over newline-delimited JSON-RPC 2.0', async () => {
    const hostToPlugin = new PassThrough();
    const pluginToHost = new PassThrough();

    const def = definePlugin({
      tools: {
        calc_divider: async (args, cadllm) => {
          const cnl = await cadllm.project.read({ detail: 0 });
          return `divider Vin=${String(args.vin)} on ${cnl}`;
        },
      },
      checks: {
        led_no_resistor: async () => [
          { level: 'warn', message: 'D1 has no series resistor', at: ['D1'] },
        ],
      },
    });

    const conn = connect(def, { input: hostToPlugin, output: pluginToHost });

    const outLines: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    let buf = '';
    pluginToHost.on('data', chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        const w = waiters.shift();
        if (w) w(line);
        else outLines.push(line);
      }
    });

    const nextMsg = (): Promise<Record<string, unknown>> => {
      const existing = outLines.shift();
      if (existing) return Promise.resolve(JSON.parse(existing) as Record<string, unknown>);
      return new Promise(resolve => {
        waiters.push(l => resolve(JSON.parse(l) as Record<string, unknown>));
      });
    };

    try {
      // 1. Host calls tool/call -> plugin calls project/read -> host responds -> plugin returns tool result
      hostToPlugin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tool/call', params: { name: 'calc_divider', args: { vin: 5 } } })}\n`);
      const readReq = await nextMsg();
      expect(readReq).toMatchObject({ jsonrpc: '2.0', method: 'project/read', params: { detail: 0 } });
      hostToPlugin.write(`${JSON.stringify({ jsonrpc: '2.0', id: readReq.id, result: 'untitled rev=1' })}\n`);

      const toolRes = await nextMsg();
      expect(toolRes).toEqual({ jsonrpc: '2.0', id: 10, result: 'divider Vin=5 on untitled rev=1' });

      // 2. Host calls check/run -> plugin returns check issues
      hostToPlugin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'check/run', params: {} })}\n`);
      const checkRes = await nextMsg();
      expect(checkRes).toEqual({
        jsonrpc: '2.0',
        id: 11,
        result: [{ level: 'warn', code: 'led_no_resistor', message: 'D1 has no series resistor', at: ['D1'] }],
      });
    } finally {
      conn.close();
    }
  });
});
