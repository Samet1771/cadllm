// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it, vi } from 'vitest';
import { createDemoBackend } from '../src/lib/demo.ts';
import {
  PANEL_CSP,
  PanelRateLimiter,
  buildPanelSrcDoc,
  createPanelMessageHandler,
  isTrustedPanelEvent,
  validatePanelMessage,
} from '../src/lib/panelHost.ts';
import {
  createInitialGrantSelection,
  describePermission,
  filterRegistryPlugins,
  parseExtListOutput,
} from '../src/lib/plugins.ts';
import type { PluginStatusItem, RegistryPluginItem } from '../src/lib/types.ts';

describe('permission wording & helpers', () => {
  it('translates permissions into plain human words', () => {
    expect(describePermission('project:read').title).toBe('Read your circuits');
    expect(describePermission('project:write').title).toBe('Change your circuits');
    expect(describePermission('net:api.example.com').title).toBe('Connect to api.example.com');
    expect(describePermission('fs:read:/tmp/data').title).toBe('Read files in /tmp/data');
    expect(describePermission('fs:write:/tmp/out').title).toBe('Write files in /tmp/out');
    expect(describePermission('custom:cap').title).toContain('custom:cap');
  });

  it('starts install permission checkboxes unchecked by default', () => {
    const sel = createInitialGrantSelection(['project:read', 'project:write', 'net:api.example.com']);
    expect(sel).toEqual({
      'project:read': false,
      'project:write': false,
      'net:api.example.com': false,
    });
  });

  it('filters registry plugins and parses ext op=list output', () => {
    const entries: RegistryPluginItem[] = [
      {
        id: 'org.example.sensors',
        name: 'Example Sensor Pack',
        summary: 'LDR and NTC sensors',
        publisher: 'example',
        versions: [],
      },
      {
        id: 'org.example.rf',
        name: 'RF Calc',
        summary: 'Impedance matcher',
        publisher: 'rf-lab',
        versions: [],
      },
    ];
    expect(filterRegistryPlugins(entries, 'ntc').map(e => e.id)).toEqual(['org.example.sensors']);
    expect(filterRegistryPlugins(entries, 'rf-lab').map(e => e.id)).toEqual(['org.example.rf']);

    const parsed = parseExtListOutput(
      'calc_divider  solve resistor divider for Vin/Vout  (org.example.sensors@1.0.0)\n',
    );
    expect(parsed).toEqual([
      {
        name: 'calc_divider',
        summary: 'solve resistor divider for Vin/Vout',
        pluginId: 'org.example.sensors',
        version: '1.0.0',
      },
    ]);
    expect(parseExtListOutput('no plugin tools installed')).toEqual([]);
  });
});

describe('panel CSP injection & postMessage validation', () => {
  it('injects strict CSP meta and cadllm bridge into srcdoc HTML', () => {
    const html = '<html><head><title>Test</title></head><body><h1>Hi</h1></body></html>';
    const out = buildPanelSrcDoc(html);
    expect(out).toContain(`<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`);
    expect(out).toContain('window.cadllm=Object.freeze');
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>Test</title>'));

    const fragment = buildPanelSrcDoc('<div>Hello</div>');
    expect(fragment).toContain(PANEL_CSP);
    expect(fragment).toContain('<div>Hello</div>');
  });

  it('validates incoming postMessage shapes strictly', () => {
    expect(validatePanelMessage({ type: 'cadllm:read', id: '1', detail: 1 })).toEqual({
      ok: true,
      request: { kind: 'read', id: '1', detail: 1 },
    });
    expect(validatePanelMessage({ type: 'cadllm:project.read', id: 2, opts: { detail: 2, select: 'R1' } })).toEqual({
      ok: true,
      request: { kind: 'read', id: 2, detail: 2, select: 'R1' },
    });
    expect(validatePanelMessage({ type: 'cadllm:requestEdit', id: '3', cnl: 'R1 res 330' })).toEqual({
      ok: true,
      request: { kind: 'requestEdit', id: '3', cnl: 'R1 res 330' },
    });
    expect(validatePanelMessage({ type: 'cadllm:project.edit', id: 4, cnl: '~R1 resistance=1k' })).toEqual({
      ok: true,
      request: { kind: 'requestEdit', id: 4, cnl: '~R1 resistance=1k' },
    });

    expect(validatePanelMessage(null).ok).toBe(false);
    expect(validatePanelMessage(['not', 'object']).ok).toBe(false);
    expect(validatePanelMessage({ type: 'cadllm:read' }).ok).toBe(false);
    expect(validatePanelMessage({ type: 'cadllm:read', id: '1', detail: 9 }).ok).toBe(false);
    expect(validatePanelMessage({ type: 'cadllm:requestEdit', id: '1', cnl: '   ' }).ok).toBe(false);
    expect(validatePanelMessage({ type: 'cadllm:requestEdit', id: '1', cnl: 'x'.repeat(40_000) }).ok).toBe(false);
    expect(validatePanelMessage({ type: 'cadllm:eval', id: '1' }).ok).toBe(false);
  });

  it('verifies event.source and opaque origin', () => {
    const win = { postMessage: vi.fn() };
    const otherWin = { postMessage: vi.fn() };
    expect(isTrustedPanelEvent({ source: win, origin: 'null' }, win)).toBe(true);
    expect(isTrustedPanelEvent({ source: win, origin: '' }, win)).toBe(true);
    expect(isTrustedPanelEvent({ source: otherWin, origin: 'null' }, win)).toBe(false);
    expect(isTrustedPanelEvent({ source: win, origin: 'https://evil.example' }, win)).toBe(false);
  });

  it('rate-limits bursts of panel requests', () => {
    let now = 1000;
    const limiter = new PanelRateLimiter({ maxRequests: 3, windowMs: 1000, now: () => now });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now = 2001;
    expect(limiter.allow()).toBe(true);
  });

  it('enforces permissions, confirmation modal, and cancellation in createPanelMessageHandler', async () => {
    const posted: unknown[] = [];
    const contentWindow = { postMessage: (msg: unknown) => posted.push(msg) };
    let grants = ['project:read'];
    const readProject = vi.fn(async () => 'untitled rev=0');
    const applyEdit = vi.fn(async (cnl: string) => `ok rev=1 (${cnl})`);
    let approveNext = true;
    const requestEditConfirmation = vi.fn(async () => approveNext);

    const handler = createPanelMessageHandler({
      getContentWindow: () => contentWindow,
      getGrantedPermissions: () => grants,
      readProject,
      requestEditConfirmation,
      applyEdit,
    });

    // Wrong source is silently ignored
    await handler({ source: {}, origin: 'null', data: { type: 'cadllm:read', id: 'x' } });
    expect(posted).toHaveLength(0);

    // Read succeeds with project:read
    await handler({ source: contentWindow, origin: 'null', data: { type: 'cadllm:read', id: 'r1', detail: 1 } });
    expect(posted.pop()).toEqual({ type: 'cadllm:response', id: 'r1', ok: true, result: 'untitled rev=0' });

    // requestEdit denied without project:write (never prompts user)
    await handler({ source: contentWindow, origin: 'null', data: { type: 'cadllm:requestEdit', id: 'e1', cnl: 'R1 res 330' } });
    expect(requestEditConfirmation).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
    expect(posted.pop()).toMatchObject({ type: 'cadllm:response', id: 'e1', ok: false });

    // Grant project:write, user cancels -> not applied
    grants = ['project:read', 'project:write'];
    approveNext = false;
    await handler({ source: contentWindow, origin: 'null', data: { type: 'cadllm:requestEdit', id: 'e2', cnl: 'R1 res 330' } });
    expect(requestEditConfirmation).toHaveBeenCalledWith('R1 res 330');
    expect(applyEdit).not.toHaveBeenCalled();
    expect(posted.pop()).toMatchObject({ type: 'cadllm:response', id: 'e2', ok: false });

    // User approves -> applied
    approveNext = true;
    await handler({ source: contentWindow, origin: 'null', data: { type: 'cadllm:requestEdit', id: 'e3', cnl: 'R1 res 330' } });
    expect(applyEdit).toHaveBeenCalledWith('R1 res 330');
    expect(posted.pop()).toEqual({ type: 'cadllm:response', id: 'e3', ok: true, result: 'ok rev=1 (R1 res 330)' });
  });
});

describe('?demo plugin backend', () => {
  it('provides a canned installed plugin with panel, ext tool, and plugin-attributed edits', async () => {
    const demo = createDemoBackend();
    const list = await demo.call<PluginStatusItem[]>('plugins.list', {});
    expect(list.some(p => p.id === 'org.example.sensors' && p.state === 'loaded')).toBe(true);

    const extList = await demo.call<string>('ext', { op: 'list' });
    expect(extList).toContain('calc_divider');

    const panel = await demo.call<{ html: string; title: string }>('plugins.panel', {
      id: 'org.example.sensors',
      panel: 'sensors',
    });
    expect(panel.title).toBe('Sensor Calculator');
    expect(panel.html).toContain('window.cadllm.requestEdit');

    const changes: { source: string }[] = [];
    demo.onChanged(n => changes.push({ source: n.source }));
    const editOut = await demo.call<string>('plugins.panelEdit', {
      id: 'org.example.sensors',
      cnl: 'R9 res 1k',
    });
    expect(editOut).toMatch(/^ok rev=/);
    expect(changes.some(c => c.source === 'plugin')).toBe(true);

    // Install second plugin from index without granting permissions
    const index = await demo.call<RegistryPluginItem[]>('plugins.index', {});
    expect(index.some(p => p.id === 'org.example.telemetry')).toBe(true);
    const installed = await demo.call<PluginStatusItem>('plugins.install', { id: 'org.example.telemetry' });
    expect(installed.grantedPermissions).toEqual([]);
  });
});
