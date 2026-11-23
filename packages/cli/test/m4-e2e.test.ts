// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseSI } from '@cadllm/core';
import { Engine, Workspace } from '@cadllm/engine';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { createServer } from '@cadllm/mcp';
import { PluginHost } from '@cadllm/plugins';
import {
  getGrants,
  grant,
  install,
  listInstalled,
  loadIndex,
  resolve as resolvePlugin,
  uninstall,
  verifyIndex,
} from '@cadllm/registry';
import { afterEach, describe, expect, it } from 'vitest';

function callText(res: Record<string, unknown>): string {
  const items = Array.isArray(res.content) ? (res.content as Array<{ type: string; text?: string }>) : [];
  return items.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

describe('M4 end-to-end: registry -> install -> grant -> PluginHost -> MCP -> sim/check -> uninstall', () => {
  const tempDirs: string[] = [];
  const prevStateDir = process.env.CADLLM_STATE_DIR;

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.CADLLM_STATE_DIR;
    else process.env.CADLLM_STATE_DIR = prevStateDir;
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('installs org.cadllm.example-sensors from dev index and drives find, ext, sim dc, check, and uninstall over MCP', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cadllm-m4-e2e-'));
    tempDirs.push(stateDir);
    process.env.CADLLM_STATE_DIR = stateDir;

    // 1. Load dev index and verify Ed25519 signatures
    const index = await loadIndex();
    expect(verifyIndex(index)).toBe(true);

    // 2. Resolve and install org.cadllm.example-sensors with NO implicit grants
    const resolved = resolvePlugin(index, 'org.cadllm.example-sensors');
    const installed = await install(resolved, { index });
    expect(installed.id).toBe('org.cadllm.example-sensors');
    expect(installed.version).toBe('1.0.0');
    expect(installed.dir.startsWith(join(stateDir, 'plugins', 'org.cadllm.example-sensors'))).toBe(true);
    expect(existsSync(join(installed.dir, 'plugin.json'))).toBe(true);
    expect(installed.grants).toEqual([]);
    expect(getGrants('org.cadllm.example-sensors')).toEqual([]);

    // 3. Explicitly grant only project:read
    expect(grant('org.cadllm.example-sensors', ['project:read'])).toEqual(['project:read']);

    const installedList = listInstalled();
    expect(installedList).toHaveLength(1);
    const pluginRecord = installedList[0]!;
    expect(pluginRecord.dir).toBe(installed.dir);

    // 4. Load PluginHost from the real install dir and wire Workspace + Engine + MCP Server/Client
    const host = new PluginHost({
      grants: id => getGrants(id),
    });
    host.load(pluginRecord.dir);

    const workspace = new Workspace({
      library: loadLibrary([builtinPartsDir]),
      plugins: host,
    });
    const engine = new Engine({ workspace });
    const [tServer, tClient] = InMemoryTransport.createLinkedPair();
    await createServer(engine).connect(tServer);
    const client = new Client({ name: 'm4-e2e-client', version: '0.0.0' });
    await client.connect(tClient);

    try {
      // Security invariant: MCP must expose no install/grant/revoke/uninstall tools
      const { tools } = await client.listTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toHaveLength(12);
      expect(toolNames).toContain('ext');
      expect(toolNames).toContain('find');
      expect(toolNames.some(n => /install|grant|revoke|uninstall|remove/i.test(n))).toBe(false);

      // 5. find q=ldr and find id=ldr / ntc10k
      const findLdr = await client.callTool({ name: 'find', arguments: { q: 'ldr' } });
      expect(findLdr.isError).not.toBe(true);
      expect(callText(findLdr)).toContain('ldr');

      const descLdr = await client.callTool({ name: 'find', arguments: { id: 'ldr' } });
      expect(descLdr.isError).not.toBe(true);
      expect(callText(descLdr)).toContain('lux*=100lx');
      expect(callText(descLdr)).toContain('sim spice:LDR');

      const descNtc = await client.callTool({ name: 'find', arguments: { id: 'ntc10k' } });
      expect(descNtc.isError).not.toBe(true);
      expect(callText(descNtc)).toContain('temp*=25C');
      expect(callText(descNtc)).toContain('sim spice:NTC10K');

      // 6. ext op=list & ext op=call calc_divider
      const extList = await client.callTool({ name: 'ext', arguments: { op: 'list' } });
      expect(extList.isError).not.toBe(true);
      expect(callText(extList)).toContain('calc_divider');
      expect(callText(extList)).toContain('(org.cadllm.example-sensors@1.0.0)');

      const calcRes = await client.callTool({
        name: 'ext',
        arguments: { op: 'call', name: 'calc_divider', args: { vin: 5, vout: 3.3 } },
      });
      expect(calcRes.isError).not.toBe(true);
      const calcText = callText(calcRes);
      const calcMatch = calcText.match(/^R1=(\S+)\s+R2=(\S+)\s+Vout=([\d.]+)V\s+err=([+-]?[\d.]+)%$/);
      expect(calcMatch, calcText).not.toBeNull();
      const r1 = parseSI(calcMatch![1]!);
      const r2 = parseSI(calcMatch![2]!);
      const vReported = Number(calcMatch![3]!);
      expect(r1).toBeGreaterThan(0);
      expect(r2).toBeGreaterThan(0);
      expect(Math.abs(vReported - 3.3) / 3.3).toBeLessThan(0.02);

      // 7. edit divider with LDR (default lux=100) + 10k resistor and verify SPICE dc V(OUT) within 2%
      const editDiv = await client.callTool({
        name: 'edit',
        arguments: {
          cnl: 'V1 dc_supply 5; R1 res 10k; R2 ldr\nVCC: V1.+ R1.1; OUT: R1.2 R2.1; GND: V1.- R2.2',
        },
      });
      expect(editDiv.isError).not.toBe(true);

      const simLdr = await client.callTool({
        name: 'sim',
        arguments: { run: 'dc probes=V(OUT)' },
      });
      expect(simLdr.isError).not.toBe(true);
      const simLdrText = callText(simLdr);
      const vOutMatch = simLdrText.match(/V\(OUT\)\s+(\S+)/);
      expect(vOutMatch, simLdrText).not.toBeNull();
      const vMeasured = parseSI(vOutMatch![1]!);
      expect(vMeasured).toBeDefined();

      // Hand calculation at default lux=100: R = 10k * (100 / 10)^(-0.7) ≈ 1995.26 Ω
      const rLdrHand = 10_000 * Math.pow(100 / 10, -0.7);
      const vHand = 5 * (rLdrHand / (10_000 + rLdrHand));
      expect(Math.abs(vMeasured! - vHand) / vHand).toBeLessThan(0.02);

      // Also verify NTC 10k divider at default temp=25C (R = 10k -> V(OUT) = 2.5V)
      await client.callTool({ name: 'project', arguments: { op: 'new', name: 'ntc-div' } });
      await client.callTool({
        name: 'edit',
        arguments: {
          cnl: 'V1 dc_supply 5; R1 res 10k; R2 ntc10k\nVCC: V1.+ R1.1; OUT: R1.2 R2.1; GND: V1.- R2.2',
        },
      });
      const simNtc = await client.callTool({
        name: 'sim',
        arguments: { run: 'dc probes=V(OUT)' },
      });
      expect(simNtc.isError).not.toBe(true);
      const vNtcMatch = callText(simNtc).match(/V\(OUT\)\s+(\S+)/);
      expect(vNtcMatch).not.toBeNull();
      const vNtc = parseSI(vNtcMatch![1]!);
      expect(Math.abs(vNtc! - 2.5) / 2.5).toBeLessThan(0.02);

      // 8. check warns on deliberately bad LED circuit (no series resistor)
      await client.callTool({ name: 'project', arguments: { op: 'new', name: 'bad-led' } });
      await client.callTool({
        name: 'edit',
        arguments: {
          cnl: 'BAT1 battery 5; D1 led red\nVCC: BAT1.+ D1.A; GND: BAT1.- D1.K',
        },
      });
      const chkBad = await client.callTool({ name: 'check', arguments: {} });
      expect(chkBad.isError).not.toBe(true);
      const chkBadText = callText(chkBad);
      expect(chkBadText).toContain('warn [org.cadllm.example-sensors]');
      expect(chkBadText).toContain('D1');

      // 9. Uninstall and verify ldr + calc_divider disappear over MCP
      expect(host.unload('org.cadllm.example-sensors')).toBe(true);
      expect(await uninstall('org.cadllm.example-sensors')).toBe(true);
      expect(listInstalled()).toEqual([]);

      const findAfter = await client.callTool({ name: 'find', arguments: { q: 'ldr' } });
      expect(findAfter.isError).not.toBe(true);
      expect(callText(findAfter)).toContain('no parts match "ldr"');

      const extAfter = await client.callTool({ name: 'ext', arguments: { op: 'list' } });
      expect(extAfter.isError).not.toBe(true);
      expect(callText(extAfter)).toContain('no plugin tools installed');
    } finally {
      await client.close();
      await host.dispose();
    }
  });
});
