// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import http from 'node:http';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, Workspace } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { PluginHost } from '../src/index.ts';

const baseLib = loadLibrary([builtinPartsDir]);
const goodDir = resolve(import.meta.dirname, 'fixtures/good-plugin');

describe('Engine + PluginHost end-to-end integration', () => {
  it('integrates parts, aliases, SPICE sim, ext list/call, check, and permission-gated project.read/edit', async () => {
    const srv = http.createServer((_req, res) => {
      res.setHeader('Connection', 'close');
      res.end('local-ok');
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const host = new PluginHost({
      grants: {
        'org.test.good': ['project:read', 'project:write', 'net:127.0.0.1'],
      },
    });

    try {
      const ws = new Workspace({ library: baseLib, plugins: host });
      const engine = new Engine({ workspace: ws });

      // Load plugin -> bumps revision and exposes parts + aliases
      const revBefore = host.revision;
      host.load(goodDir);
      expect(host.revision).toBe(revBefore + 1);

      expect(engine.find({ q: 'therm_test' })).toContain('therm_test');
      expect(engine.find({ id: 'therm_test' })).toContain('sim spice:GOOD_THERM');
      expect(engine.library.get('org.test.good:therm_test')?.id).toBe('therm_test');
      expect(engine.library.get('org.test.good/therm_test')?.id).toBe('therm_test');
      expect(engine.library.get('res')?.name).toBe('Resistor');
      expect(engine.library.get('org.test.good:res')?.name).toBe('Plugin Override Resistor');
      expect(engine.library.get('org.test.good/res')?.name).toBe('Plugin Override Resistor');

      // Build LED without resistor and verify plugin check output is tagged [org.test.good]
      engine.edit({ cnl: 'BAT1 battery 5; D1 led red\nVCC: BAT1.+ D1.A; GND: BAT1.- D1.K' });
      const chk = await engine.check();
      expect(chk).toContain('warn [org.test.good] LED has no series resistor');

      // ext list & call
      expect(await engine.ext({ op: 'list' })).toContain('summarize_circuit  summarize active project  (org.test.good@1.2.3)');
      expect(await engine.ext({ op: 'call', name: 'summarize_circuit' })).toContain('summary:untitled rev=1');
      expect(await engine.ext({ op: 'call', name: 'lookup_part', args: { id: 'therm_test' } })).toBe(
        'therm_test:Test Thermistor',
      );
      expect(
        await engine.ext({ op: 'call', name: 'ping_local', args: { url: `http://127.0.0.1:${port}/ping` } }),
      ).toBe('local-ok');

      // project.edit from plugin is attributed source: 'plugin' in history log
      const editOut = await engine.ext({ op: 'call', name: 'add_test_res', args: { resistance: '1k' } });
      expect(editOut).toMatch(/^ok rev=2 \+R99/);
      expect(engine.history({ op: 'log', n: 1 })).toContain('rev 2 plugin: +R99');

      // SPICE simulation with plugin part + subckt model
      engine.project({ op: 'new', name: 'therm-div' });
      engine.edit({
        cnl: 'V1 dc_supply 5; R1 res 1k; R2 therm_test 25\nVCC: V1.+ R1.1; OUT: R1.2 R2.1; GND: V1.- R2.2',
      });
      // At temp=25, R_therm = 1k -> V(OUT) = 2.5V
      expect(await engine.sim({ run: 'dc; expect V(OUT) 2.45..2.55' })).toContain('PASS V(OUT)');
      // At temp=35, R_therm = 2k -> V(OUT) = 5 * 2/3 = 3.33V
      engine.edit({ cnl: '~R2 temp=35' });
      expect(await engine.sim({ run: 'dc; expect V(OUT) 3.28..3.38' })).toContain('PASS V(OUT)');

      // Unloading bumps revision and invalidates library cache
      expect(host.unload('org.test.good')).toBe(true);
      expect(engine.library.get('therm_test')).toBeUndefined();
    } finally {
      srv.closeAllConnections();
      await new Promise<void>(r => srv.close(() => r()));
      await host.dispose();
    }
  });

  it('denies project.read and project.edit when corresponding grants are absent', async () => {
    const hostNoRead = new PluginHost({ grants: { 'org.test.good': [] } });
    const hostReadOnly = new PluginHost({ grants: { 'org.test.good': ['project:read'] } });

    try {
      const e1 = new Engine({ library: baseLib, plugins: hostNoRead });
      hostNoRead.load(goodDir);
      e1.edit({ cnl: 'R1 res 1k' });
      await expect(e1.ext({ op: 'call', name: 'summarize_circuit' })).rejects.toThrow(/permission denied: project:read/);
      await expect(e1.ext({ op: 'call', name: 'add_test_res' })).rejects.toThrow(/permission denied: project:write/);

      const e2 = new Engine({ library: baseLib, plugins: hostReadOnly });
      hostReadOnly.load(goodDir);
      e2.edit({ cnl: 'R1 res 1k' });
      expect(await e2.ext({ op: 'call', name: 'summarize_circuit' })).toContain('summary:untitled rev=1');
      await expect(e2.ext({ op: 'call', name: 'add_test_res' })).rejects.toThrow(/permission denied: project:write/);
    } finally {
      await hostNoRead.dispose();
      await hostReadOnly.dispose();
    }
  });
});
