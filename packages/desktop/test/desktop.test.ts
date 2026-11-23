// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePluginRuntime } from '@cadllm/plugins';
import { findServe, startServer, type RunningServer } from '@cadllm/server';
import { resolveArduinoCli } from '@cadllm/sim-mcu';
import { buildMenuTemplate } from '../src/menu.ts';
import { extractCnlArg, ONLINE_REGISTRY_URL, resolveDesktopResources, resolveRegistryConfig } from '../src/paths.ts';
import {
  allowedDesktopOrigins,
  buildAppUrl,
  buildDesktopCsp,
  createWindowOptions,
  isAllowedNavigationUrl,
  isAllowedNetworkUrl,
} from '../src/security.ts';

describe('@cadllm/desktop pure units', () => {
  const dirs: string[] = [];
  const servers: RunningServer[] = [];

  function makeTempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('configures BrowserWindow with hardened security flags and no ?demo', () => {
    const winOpts = createWindowOptions({
      preloadPath: 'C:/app/dist/preload.cjs',
      iconPath: 'C:/app/build/icon.ico',
    });

    expect(winOpts.show).toBe(false);
    expect(winOpts.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: 'C:/app/dist/preload.cjs',
    });

    // ?demo is always stripped and remote URLs are rejected
    expect(buildAppUrl('http://127.0.0.1:54321/?demo')).toBe('http://127.0.0.1:54321/');
    expect(buildAppUrl('http://127.0.0.1:54321/?demo=1&foo=bar')).toBe('http://127.0.0.1:54321/?foo=bar');
    expect(() => buildAppUrl('https://evil.example/')).toThrow(/http loopback/i);
    expect(() => buildAppUrl('http://example.com:5170/')).toThrow(/non-loopback/i);
  });

  it('builds strict CSP and blocks remote network/navigation targets', () => {
    const prodCsp = buildDesktopCsp('http://127.0.0.1:51234');
    expect(prodCsp).toContain("default-src 'none'");
    expect(prodCsp).toContain("script-src 'self'");
    expect(prodCsp).not.toContain("'unsafe-eval'");
    expect(prodCsp).toContain('connect-src \'self\' http://127.0.0.1:51234 ws://127.0.0.1:51234');
    expect(prodCsp).toContain("object-src 'none'");

    const allowed = allowedDesktopOrigins('http://127.0.0.1:51234');
    expect(isAllowedNavigationUrl('http://127.0.0.1:51234/index.html', 'http://127.0.0.1:51234')).toBe(true);
    expect(isAllowedNavigationUrl('https://example.com/', 'http://127.0.0.1:51234')).toBe(false);
    expect(isAllowedNetworkUrl('http://127.0.0.1:51234/assets/main.js', allowed)).toBe(true);
    expect(isAllowedNetworkUrl('ws://127.0.0.1:51234/ws', allowed)).toBe(true);
    expect(isAllowedNetworkUrl('about:srcdoc', allowed)).toBe(true);
    expect(isAllowedNetworkUrl('data:image/png;base64,AAAA', allowed)).toBe(true);
    expect(isAllowedNetworkUrl('https://cdn.example.com/script.js', allowed)).toBe(false);
    expect(isAllowedNetworkUrl('http://127.0.0.1:9999/other', allowed)).toBe(false);
  });

  it('builds File > New / Open / Save / Save As / Quit menu template and dispatches handlers', () => {
    const calls: string[] = [];
    const template = buildMenuTemplate({
      onNew: () => calls.push('new'),
      onOpen: () => calls.push('open'),
      onSave: () => calls.push('save'),
      onSaveAs: () => calls.push('saveAs'),
      onQuit: () => calls.push('quit'),
      onMcpInfo: () => calls.push('mcp'),
      onAbout: () => calls.push('about'),
    });

    const fileMenu = template.find(item => item.label === '&File');
    expect(fileMenu).toBeDefined();
    const sub = fileMenu?.submenu as { label?: string; accelerator?: string; click?: () => void }[];
    const labels = sub.filter(i => i.label).map(i => i.label);
    expect(labels).toEqual(['New Circuit', 'Open…', 'Save', 'Save As…', 'Quit']);

    for (const item of sub) item.click?.();
    expect(calls).toEqual(['new', 'open', 'save', 'saveAs', 'quit']);
  });

  it('resolves plugin runtime and ELECTRON_RUN_AS_NODE=1 across Node and Electron binaries', () => {
    const inElectron = resolvePluginRuntime({
      execPath: 'C:\\Program Files\\CadLLM\\CadLLM.exe',
      versions: { electron: '45.4.1', node: '24.22.3' },
      env: {},
    });
    expect(inElectron).toEqual({
      execPath: 'C:\\Program Files\\CadLLM\\CadLLM.exe',
      runAsNode: true,
    });

    const overrideNode = resolvePluginRuntime({
      execPath: 'C:\\Program Files\\CadLLM\\CadLLM.exe',
      versions: { electron: '45.4.1', node: '24.22.3' },
      env: { CADLLM_NODE_PATH: 'C:\\Program Files\\nodejs\\node.exe' },
    });
    expect(overrideNode).toEqual({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      runAsNode: false,
    });

    const electronOverride = resolvePluginRuntime({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      versions: { node: '24.19.0' },
      env: { CADLLM_PLUGIN_RUNTIME: 'C:\\CadLLm\\node_modules\\electron\\dist\\electron.exe' },
    });
    expect(electronOverride).toEqual({
      execPath: 'C:\\CadLLm\\node_modules\\electron\\dist\\electron.exe',
      runAsNode: true,
    });

    const plainNode = resolvePluginRuntime({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      versions: { node: '24.19.0' },
      env: {},
    });
    expect(plainNode).toEqual({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      runAsNode: false,
    });
  });

  it('extracts .cnl startup args and resolves dev vs packaged resources', () => {
    const cwd = resolve('C:/CadLLm');
    expect(extractCnlArg(['CadLLM.exe', '--ozone-platform=x11', 'examples/nand-led.cnl'], cwd)).toBe(
      resolve(cwd, 'examples/nand-led.cnl'),
    );
    expect(extractCnlArg(['electron.exe', 'dist/main.mjs'], cwd)).toBeUndefined();

    const pkg = resolveDesktopResources({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\CadLLM\\resources',
    });
    expect(pkg.partsDir).toBe(join('C:\\Program Files\\CadLLM\\resources', 'parts'));
    expect(pkg.networkGuardPath).toBe(join('C:\\Program Files\\CadLLM\\resources', 'plugin-runtime', 'guard.mjs'));
    expect(pkg.pluginApiEntry).toBe(join('C:\\Program Files\\CadLLM\\resources', 'plugin-runtime', 'plugin-api.mjs'));
    expect(pkg.uiDistDir).toBe(join('C:\\Program Files\\CadLLM\\resources', 'ui-dist'));
  });

  it('writes serve.json on a free port and removes it cleanly on close()', async () => {
    const root = makeTempDir('cadllm-desk-root-');
    const serveFileDir = makeTempDir('cadllm-desk-state-');
    const srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      root,
      serveFileDir,
      uiDistDir: join(root, 'missing-ui'),
    });
    servers.push(srv);

    const serveFile = join(serveFileDir, 'serve.json');
    expect(existsSync(serveFile)).toBe(true);
    const meta = JSON.parse(readFileSync(serveFile, 'utf8')) as { port: number; pid: number };
    expect(meta.port).toBe(srv.port);
    expect(meta.pid).toBe(process.pid);
    expect(await findServe({ serveFileDir })).toBe(srv.url);

    await srv.close();
    servers.pop();
    expect(existsSync(serveFile)).toBe(false);
    expect(await findServe({ serveFileDir })).toBeUndefined();
  });

  it('resolves bundled registry paths by default and honors ~/.cadllm/config.json overrides', () => {
    const stateDir = makeTempDir('cadllm-reg-cfg-');
    const defaultIndexUrl = 'C:\\Program Files\\CadLLM\\resources\\registry\\index.json';
    const defaultPublicKeyPath = 'C:\\Program Files\\CadLLM\\resources\\registry\\registry.pub';

    expect(
      resolveRegistryConfig({
        stateDir,
        defaultIndexUrl,
        defaultPublicKeyPath,
        env: {},
      }),
    ).toEqual({
      indexUrl: defaultIndexUrl,
      registryPublicKey: defaultPublicKeyPath,
    });

    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({
        registryUrl: ONLINE_REGISTRY_URL,
        registryPublicKey: 'CUSTOM_KEY_PEM',
      }),
      'utf8',
    );

    expect(
      resolveRegistryConfig({
        stateDir,
        defaultIndexUrl,
        defaultPublicKeyPath,
        env: {},
      }),
    ).toEqual({
      indexUrl: ONLINE_REGISTRY_URL,
      registryPublicKey: 'CUSTOM_KEY_PEM',
    });
  });

  it('produces clear error when arduino-cli is missing via CADLLM_ARDUINO_CLI', () => {
    const prev = process.env.CADLLM_ARDUINO_CLI;
    process.env.CADLLM_ARDUINO_CLI = join(tmpdir(), 'nonexistent-arduino-cli-12345.exe');
    try {
      expect(() => resolveArduinoCli()).toThrow(/arduino-cli not found/);
    } finally {
      if (prev === undefined) delete process.env.CADLLM_ARDUINO_CLI;
      else process.env.CADLLM_ARDUINO_CLI = prev;
    }
  });
});
