// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { PluginHost } from '@cadllm/plugins';
import { resolveStateDir } from '@cadllm/registry';
import { startServer, type RunningServer } from '@cadllm/server';
import { buildMenuTemplate } from './menu.ts';
import { extractCnlArg, resolveDesktopResources, resolveRegistryConfig } from './paths.ts';
import {
  allowedDesktopOrigins,
  buildAppUrl,
  buildDesktopCsp,
  createWindowOptions,
  isAllowedNavigationUrl,
  isAllowedNetworkUrl,
} from './security.ts';

const DESKTOP_USER_DATA_OVERRIDE = process.env.CADLLM_DESKTOP_USER_DATA?.trim();
if (DESKTOP_USER_DATA_OVERRIDE) {
  app.setPath('userData', resolve(DESKTOP_USER_DATA_OVERRIDE));
}

interface WasmNamespace {
  instantiate(bytes: ArrayBuffer, importObject?: Record<string, unknown>): Promise<unknown>;
  instantiateStreaming?: (
    source: Response | PromiseLike<Response>,
    importObject?: Record<string, unknown>,
  ) => Promise<unknown>;
}

// Electron's browser/main process disables WebAssembly.instantiateStreaming, which eecircuit-engine needs for data: URL WASM.
const wasm = (globalThis as { WebAssembly?: WasmNamespace }).WebAssembly;
if (wasm && typeof wasm.instantiateStreaming !== 'function') {
  wasm.instantiateStreaming = async (source, importObject) => {
    const response = await source;
    const bytes = await response.arrayBuffer();
    return wasm.instantiate(bytes, importObject);
  };
}

const isHeadless = process.env.CADLLM_HEADLESS === '1';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | undefined;
let shuttingDown = false;
let pendingOpenFile: string | undefined;

function getDefaultDialogDir(): string {
  const active = server?.activeProject?.();
  if (active?.path) return dirname(active.path);
  const envRoot = process.env.CADLLM_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  try {
    return app.getPath('documents');
  } catch {
    return process.cwd();
  }
}

function updateWindowTitle(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = server?.activeProject?.();
  if (!active) {
    mainWindow.setTitle('CadLLM');
    return;
  }
  const label = active.path ?? active.name;
  mainWindow.setTitle(`CadLLM — ${label}`);
}

function openCnlPath(filePath: string): void {
  if (!server?.projectCommand) return;
  try {
    server.projectCommand({ op: 'open', path: filePath });
    updateWindowTitle();
  } catch (err) {
    if (!isHeadless) {
      dialog.showErrorBox('Failed to open file', err instanceof Error ? err.message : String(err));
    }
  }
}

async function handleFileNew(): Promise<void> {
  if (!server?.projectCommand) return;
  server.projectCommand({ op: 'new' });
  updateWindowTitle();
}

async function handleFileOpen(): Promise<void> {
  if (!server?.projectCommand) return;
  const opts: Electron.OpenDialogOptions = {
    title: 'Open Circuit (.cnl)',
    defaultPath: getDefaultDialogDir(),
    properties: ['openFile'],
    filters: [
      { name: 'CadLLM Circuits', extensions: ['cnl'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const res = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return;
  openCnlPath(res.filePaths[0]);
}

async function handleFileSaveAs(): Promise<void> {
  if (!server?.projectCommand) return;
  const active = server.activeProject?.();
  const baseName = `${active?.name ?? 'untitled'}.cnl`;
  const opts: Electron.SaveDialogOptions = {
    title: 'Save Circuit As',
    defaultPath: active?.path ?? join(getDefaultDialogDir(), baseName),
    filters: [{ name: 'CadLLM Circuit (.cnl)', extensions: ['cnl'] }],
  };
  const res = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, opts)
    : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return;
  try {
    server.projectCommand({ op: 'save', path: res.filePath });
    updateWindowTitle();
  } catch (err) {
    dialog.showErrorBox('Failed to save circuit', err instanceof Error ? err.message : String(err));
  }
}

async function handleFileSave(): Promise<void> {
  if (!server?.projectCommand) return;
  const active = server.activeProject?.();
  if (active?.path) {
    try {
      server.projectCommand({ op: 'save' });
      updateWindowTitle();
    } catch (err) {
      dialog.showErrorBox('Failed to save circuit', err instanceof Error ? err.message : String(err));
    }
    return;
  }
  await handleFileSaveAs();
}

async function shutdownAndQuit(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) {
      const activeServer = server;
      server = undefined;
      await activeServer.close();
    }
  } finally {
    app.exit(exitCode);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const cnl = extractCnlArg(argv, workingDirectory);
    if (cnl) {
      if (server) openCnlPath(cnl);
      else pendingOpenFile = cnl;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!isHeadless) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('before-quit', event => {
    if (!shuttingDown && server) {
      event.preventDefault();
      void shutdownAndQuit(0);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.quit();
    });
  }

  const headlessQuitFile = isHeadless ? process.env.CADLLM_HEADLESS_QUIT_FILE?.trim() : undefined;
  if (headlessQuitFile) {
    const quitTimer = setInterval(() => {
      if (existsSync(headlessQuitFile)) {
        clearInterval(quitTimer);
        app.quit();
      }
    }, 50);
    quitTimer.unref();
  }

  app.whenReady().then(async () => {
    const mainDir = dirname(fileURLToPath(import.meta.url));
    const desktopRoot = resolve(mainDir, '..');
    const repoRoot = resolve(desktopRoot, '../..');
    const paths = resolveDesktopResources({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot,
      desktopRoot,
    });

    const initialCnl = pendingOpenFile ?? extractCnlArg(process.argv);
    const workspaceRoot = process.env.CADLLM_ROOT?.trim() || getDefaultDialogDir();
    const rawPort = process.env.CADLLM_PORT?.trim();
    const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : 0;
    const stateDirOverride = process.env.CADLLM_STATE_DIR?.trim() || undefined;
    const effectiveStateDir = resolveStateDir(stateDirOverride);
    const registryConfig = resolveRegistryConfig({
      stateDir: effectiveStateDir,
      defaultIndexUrl: paths.registryIndexPath,
      defaultPublicKeyPath: paths.registryPubPath,
    });
    const devUiUrl = process.env.CADLLM_DEV_UI_URL?.trim() || undefined;

    const pluginHost = new PluginHost({
      networkGuardPath: paths.networkGuardPath,
      pluginApiEntry: paths.pluginApiEntry,
      zodDir: null,
    });

    server = await startServer({
      port,
      host: '127.0.0.1',
      root: workspaceRoot,
      ...(initialCnl && existsSync(initialCnl) ? { open: initialCnl } : {}),
      ...(stateDirOverride ? { serveFileDir: stateDirOverride } : {}),
      uiDistDir: paths.uiDistDir,
      partsDirs: [paths.partsDir],
      wsOptions: {
        stateDir: effectiveStateDir,
        indexUrl: registryConfig.indexUrl,
        registryPublicKey: registryConfig.registryPublicKey,
        pluginHost,
      },
    });

    const appUrl = buildAppUrl(server.url, devUiUrl);
    const appOrigin = new URL(appUrl).origin;
    const allowedOrigins = allowedDesktopOrigins(server.url, devUiUrl);
    const csp = buildDesktopCsp(server.url, { ...(devUiUrl ? { devUiUrl } : {}) });

    const defaultSess = session.defaultSession;
    defaultSess.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

    defaultSess.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedNetworkUrl(details.url, allowedOrigins) });
    });

    defaultSess.webRequest.onHeadersReceived((details, callback) => {
      if (!isAllowedNavigationUrl(details.url, appOrigin)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = { ...(details.responseHeaders ?? {}) };
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-security-policy') delete headers[k];
      }
      headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
    });

    const menu = Menu.buildFromTemplate(
      buildMenuTemplate(
        {
          onNew: () => void handleFileNew(),
          onOpen: () => void handleFileOpen(),
          onSave: () => void handleFileSave(),
          onSaveAs: () => void handleFileSaveAs(),
          onQuit: () => app.quit(),
          onMcpInfo: () => {
            if (!server) return;
            const opts: Electron.MessageBoxOptions = {
              type: 'info',
              title: 'MCP Server Status',
              message: `CadLLM Engine listening at ${server.url}`,
              detail: `Streamable HTTP MCP: ${server.url}/mcp\n` +
                'Local `cadllm mcp` attaches automatically via serve.json while CadLLM is open.',
            };
            if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, opts);
            else void dialog.showMessageBox(opts);
          },
          onAbout: () => {
            const opts: Electron.MessageBoxOptions = {
              type: 'info',
              title: 'About CadLLM',
              message: `CadLLM Desktop v${app.getVersion()}`,
              detail:
                `Electron ${process.versions.electron} · Node ${process.versions.node}\n` +
                'License: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception',
            };
            if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, opts);
            else void dialog.showMessageBox(opts);
          },
        },
        { isMac: process.platform === 'darwin' },
      ),
    );
    Menu.setApplicationMenu(menu);

    const preloadPath = resolve(mainDir, 'preload.cjs');
    const win = new BrowserWindow(
      createWindowOptions({
        preloadPath,
        ...(existsSync(paths.iconPath) ? { iconPath: paths.iconPath } : {}),
        show: false,
      }),
    );
    mainWindow = win;

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isAllowedNavigationUrl(targetUrl, appOrigin)) {
        event.preventDefault();
      }
    });
    win.webContents.on('will-attach-webview', event => {
      event.preventDefault();
    });

    win.once('ready-to-show', () => {
      updateWindowTitle();
      if (!isHeadless && !win.isDestroyed()) {
        win.show();
      }
    });
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });

    await win.loadURL(appUrl);
    updateWindowTitle();
  }).catch(err => {
    console.error(err);
    void shutdownAndQuit(1);
  });
}
