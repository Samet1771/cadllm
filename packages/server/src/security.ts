// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { IncomingMessage } from 'node:http';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** Extract hostname (without port) from a Host header value. */
function parseHostHeader(host: string): string | undefined {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return undefined;
    const rest = trimmed.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return undefined;
    return trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  if (trimmed.indexOf(':', colon + 1) !== -1) return undefined;
  const port = trimmed.slice(colon + 1);
  if (!/^\d+$/.test(port)) return undefined;
  return trimmed.slice(0, colon);
}

/** True when the HTTP Host header names a loopback address. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = parseHostHeader(host);
  return name !== undefined && LOCAL_HOSTS.has(name);
}

/**
 * True when Origin is absent (non-browser clients) or points to a loopback host.
 * Rejects opaque `"null"` origins and non-loopback origins to guard against DNS rebinding.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null' || !origin) return false;
  try {
    const url = new URL(origin);
    return ALLOWED_PROTOCOLS.has(url.protocol) && LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Guard against DNS-rebinding: require loopback Host and, if present, loopback Origin. */
export function isLocalRequest(req: IncomingMessage): boolean {
  return isAllowedHost(req.headers.host) && isAllowedOrigin(req.headers.origin);
}
