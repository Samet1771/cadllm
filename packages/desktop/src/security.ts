// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { BrowserWindowConstructorOptions } from 'electron';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface WindowOptionsInput {
  preloadPath: string;
  iconPath?: string;
  width?: number;
  height?: number;
  show?: boolean;
}

/** Build hardened BrowserWindow constructor options with contextIsolation/sandbox on and nodeIntegration off. */
export function createWindowOptions(opts: WindowOptionsInput): BrowserWindowConstructorOptions {
  return {
    title: 'CadLLM',
    width: opts.width ?? 1360,
    height: opts.height ?? 860,
    minWidth: 960,
    minHeight: 640,
    show: opts.show ?? false,
    autoHideMenuBar: false,
    ...(opts.iconPath ? { icon: opts.iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: opts.preloadPath,
    },
  };
}

function assertLoopbackHttpOrigin(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:') {
    throw new Error(`desktop app only permits http loopback URLs (got ${parsed.protocol})`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`desktop app refuses non-loopback host "${parsed.hostname}"`);
  }
  return parsed;
}

/**
 * Resolve the local UI entry URL loaded into the BrowserWindow.
 * Strips `?demo` so desktop mode always attaches to the live in-process engine server.
 */
export function buildAppUrl(serverUrl: string, devUiUrl?: string): string {
  const base = assertLoopbackHttpOrigin(devUiUrl?.trim() || serverUrl);
  base.searchParams.delete('demo');
  if (!base.pathname) base.pathname = '/';
  return base.toString();
}

export interface CspOptions {
  devUiUrl?: string;
}

/** Build the strict Content-Security-Policy applied to the desktop app window. */
export function buildDesktopCsp(serverUrl: string, opts: CspOptions = {}): string {
  const serverOrigin = assertLoopbackHttpOrigin(serverUrl);
  const wsServerOrigin = `ws://${serverOrigin.host}`;
  const connectSources = ["'self'", serverOrigin.origin, wsServerOrigin];
  let scriptSrc = "'self'";

  const dev = opts.devUiUrl?.trim();
  if (dev) {
    const devOrigin = assertLoopbackHttpOrigin(dev);
    const wsDevOrigin = `ws://${devOrigin.host}`;
    if (!connectSources.includes(devOrigin.origin)) connectSources.push(devOrigin.origin);
    if (!connectSources.includes(wsDevOrigin)) connectSources.push(wsDevOrigin);
    // Vite React Refresh dev server injects an inline module preamble during development only.
    scriptSrc = "'self' 'unsafe-inline'";
  }

  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "frame-src 'self' about:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Return allowed HTTP + WS origins for local desktop network requests. */
export function allowedDesktopOrigins(serverUrl: string, devUiUrl?: string): string[] {
  const origins = new Set<string>();
  const srv = assertLoopbackHttpOrigin(serverUrl);
  origins.add(srv.origin);
  origins.add(`ws://${srv.host}`);
  if (devUiUrl?.trim()) {
    const dev = assertLoopbackHttpOrigin(devUiUrl.trim());
    origins.add(dev.origin);
    origins.add(`ws://${dev.host}`);
  }
  return [...origins];
}

/** Return true only when navigation stays within the allowed loopback app origin. */
export function isAllowedNavigationUrl(targetUrl: string, allowedOrigin: string): boolean {
  try {
    const target = new URL(targetUrl);
    const allowed = assertLoopbackHttpOrigin(allowedOrigin);
    return target.origin === allowed.origin;
  } catch {
    return false;
  }
}

/** Return true only for local app origins and safe non-network schemes (`about:`, `data:`, `blob:`, `devtools:`). */
export function isAllowedNetworkUrl(targetUrl: string, allowedOrigins: readonly string[]): boolean {
  try {
    const u = new URL(targetUrl);
    const proto = u.protocol.toLowerCase();
    if (proto === 'about:' || proto === 'data:' || proto === 'blob:' || proto === 'devtools:') {
      return true;
    }
    if (proto !== 'http:' && proto !== 'ws:') {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
      return false;
    }
    return allowedOrigins.includes(u.origin);
  } catch {
    return false;
  }
}
