// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
// Preloaded into plugin child processes via `node --import <NETWORK_GUARD_PATH>` (M4 WP1).
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const rawPluginApiPath = process.env.CADLLM_PLUGIN_API_PATH;
delete process.env.CADLLM_PLUGIN_API_PATH;
const PLUGIN_API_URL = rawPluginApiPath
  ? pathToFileURL(rawPluginApiPath).href
  : new URL('../../plugin-api/src/index.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cadllm/plugin-api') {
      return { url: PLUGIN_API_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const rawAllowed = process.env.CADLLM_ALLOWED_HOSTS ?? '';
delete process.env.CADLLM_ALLOWED_HOSTS;

/** @type {Map<string, Set<number | null>>} */
const allowedHosts = new Map();

function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  let s = host.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s;
}

for (const item of rawAllowed.split(',')) {
  const entry = item.trim().toLowerCase();
  if (!entry) continue;
  let host = entry;
  /** @type {number | null} */
  let port = null;
  if (entry.startsWith('[')) {
    const m = entry.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!m) continue;
    host = m[1].toLowerCase();
    port = m[2] !== undefined ? Number(m[2]) : null;
  } else {
    const idx = entry.indexOf(':');
    if (idx !== -1 && entry.indexOf(':', idx + 1) === -1) {
      host = entry.slice(0, idx);
      const p = Number(entry.slice(idx + 1));
      if (!Number.isInteger(p) || p <= 0 || p > 65535) continue;
      port = p;
    }
  }
  host = normalizeHost(host);
  if (!host) continue;
  let ports = allowedHosts.get(host);
  if (!ports) {
    ports = new Set();
    allowedHosts.set(host, ports);
  }
  ports.add(port);
}

function denied(target) {
  const err = new Error(`Network access to "${target}" denied by CadLLM sandbox`);
  err.code = 'ERR_NETWORK_ACCESS_DENIED';
  return err;
}

function isAllowed(host, port) {
  const h = normalizeHost(host);
  if (!h) return false;
  const ports = allowedHosts.get(h);
  if (!ports) return false;
  if (ports.has(null)) return true;
  if (port !== undefined && port !== null && port !== '') {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return ports.has(n);
  }
  return false;
}

function isHostAllowedForDns(host) {
  const h = normalizeHost(host);
  return h.length > 0 && allowedHosts.has(h);
}

function assertAllowed(host, port, label) {
  if (!isAllowed(host, port)) {
    const h = normalizeHost(host);
    const target = label ?? (port !== undefined && h && allowedHosts.has(h) ? `${h}:${port}` : h || 'unknown');
    throw denied(target);
  }
}

function lockProp(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

function splitHostPort(rawHost) {
  if (typeof rawHost !== 'string') return { host: undefined, port: undefined };
  const s = rawHost.trim();
  if (!s) return { host: undefined, port: undefined };
  if (s.startsWith('[')) {
    const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return m ? { host: m[1], port: m[2] ? Number(m[2]) : undefined } : { host: s, port: undefined };
  }
  const idx = s.indexOf(':');
  if (idx !== -1 && s.indexOf(':', idx + 1) === -1) {
    const p = Number(s.slice(idx + 1));
    return { host: s.slice(0, idx), port: Number.isFinite(p) ? p : undefined };
  }
  return { host: s, port: undefined };
}

function defaultPortForProtocol(proto) {
  const p = typeof proto === 'string' ? proto.toLowerCase() : '';
  if (p === 'https:' || p === 'wss:') return 443;
  if (p === 'http:' || p === 'ws:') return 80;
  return undefined;
}

function parseUrlTarget(input, defaultProto) {
  let raw = '';
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input && typeof input === 'object' && typeof input.url === 'string') raw = input.url;
  else throw denied('invalid-url');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw denied(raw || 'invalid-url');
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') {
    throw denied(u.host || u.protocol || raw);
  }
  const port = u.port ? Number(u.port) : defaultPortForProtocol(proto || defaultProto);
  return { host: u.hostname, port, label: u.host || u.hostname || raw };
}

function parseNetArgs(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'object' && first !== null) {
    if (first.path) return { host: '', port: undefined, label: String(first.path) };
    const host = first.host ?? first.hostname ?? 'localhost';
    return { host, port: first.port, label: `${host}${first.port !== undefined ? `:${first.port}` : ''}` };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const port = Number(first);
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port, label: `${host}:${port}` };
  }
  return { host: '', port: undefined, label: String(first ?? 'ipc') };
}

function parseTlsArgs(args) {
  let opts = {};
  let port;
  let host;
  if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
    port = Number(args[0]);
    if (typeof args[1] === 'string') {
      host = args[1];
      if (typeof args[2] === 'object' && args[2] !== null) opts = args[2];
    } else if (typeof args[1] === 'object' && args[1] !== null) {
      opts = args[1];
    }
  } else if (typeof args[0] === 'object' && args[0] !== null) {
    opts = args[0];
  }
  if (opts.path) return { host: '', port: undefined, label: String(opts.path) };
  const resolvedHost = host ?? opts.host ?? opts.servername ?? 'localhost';
  const resolvedPort = port ?? opts.port;
  return {
    host: resolvedHost,
    port: resolvedPort,
    label: `${resolvedHost}${resolvedPort !== undefined ? `:${resolvedPort}` : ''}`,
  };
}

function parseHttpArgs(args, defaultProto) {
  let urlPart;
  let opts = {};
  const a0 = args[0];
  const a1 = args[1];
  if (typeof a0 === 'string' || a0 instanceof URL) {
    try {
      urlPart = typeof a0 === 'string' ? new URL(a0) : a0;
    } catch {
      throw denied(String(a0));
    }
    if (typeof a1 === 'object' && a1 !== null && typeof a1 !== 'function') opts = a1;
  } else if (typeof a0 === 'object' && a0 !== null) {
    opts = a0;
  } else {
    throw denied(String(a0 ?? 'unknown'));
  }

  if (opts.socketPath) throw denied(String(opts.socketPath));
  const proto = String(opts.protocol ?? urlPart?.protocol ?? defaultProto).toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    throw denied(String(opts.hostname ?? opts.host ?? urlPart?.hostname ?? proto));
  }
  const fromHost = splitHostPort(opts.host);
  const hostname = opts.hostname ?? fromHost.host ?? urlPart?.hostname ?? 'localhost';
  const port = opts.port ?? fromHost.port ?? (urlPart?.port ? Number(urlPart.port) : undefined) ?? defaultPortForProtocol(proto);
  return { host: hostname, port, label: `${hostname}${port !== undefined ? `:${port}` : ''}` };
}

function parseDgramSendArgs(args) {
  if (typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number') {
    const port = args[3];
    const address = typeof args[4] === 'string' ? args[4] : 'localhost';
    return { host: address, port, label: `${address}:${port}` };
  }
  if (typeof args[1] === 'number') {
    const port = args[1];
    const address = typeof args[2] === 'string' ? args[2] : 'localhost';
    return { host: address, port, label: `${address}:${port}` };
  }
  return null;
}

// Acquire builtin modules BEFORE any ESM module facade is initialized.
const net = process.getBuiltinModule('node:net');
const tls = process.getBuiltinModule('node:tls');
const dgram = process.getBuiltinModule('node:dgram');
const http = process.getBuiltinModule('node:http');
const https = process.getBuiltinModule('node:https');
const http2 = process.getBuiltinModule('node:http2');
const dns = process.getBuiltinModule('node:dns');
const dnsPromises = process.getBuiltinModule('node:dns/promises');

// 1. node:net
const origSocketConnect = net.Socket.prototype.connect;
const origNetConnect = net.connect;
const origNetCreateConnection = net.createConnection;

lockProp(net.Socket.prototype, 'connect', function connect(...args) {
  const t = parseNetArgs(args);
  assertAllowed(t.host, t.port, t.label);
  return origSocketConnect.apply(this, args);
});
Object.preventExtensions(net.Socket.prototype);

lockProp(net, 'connect', function connect(...args) {
  const t = parseNetArgs(args);
  assertAllowed(t.host, t.port, t.label);
  return origNetConnect.apply(this, args);
});
lockProp(net, 'createConnection', function createConnection(...args) {
  const t = parseNetArgs(args);
  assertAllowed(t.host, t.port, t.label);
  return origNetCreateConnection.apply(this, args);
});
lockProp(net.Server.prototype, 'listen', function listen() {
  throw denied('listen');
});
Object.preventExtensions(net.Server.prototype);
Object.freeze(net.Socket);
Object.freeze(net.Server);
Object.freeze(net);

// 2. node:tls
const origTlsConnect = tls.connect;
lockProp(tls, 'connect', function connect(...args) {
  const t = parseTlsArgs(args);
  assertAllowed(t.host, t.port, t.label);
  return origTlsConnect.apply(this, args);
});
lockProp(tls.Server.prototype, 'listen', function listen() {
  throw denied('listen');
});
Object.preventExtensions(tls.Server.prototype);
Object.preventExtensions(tls.TLSSocket.prototype);
Object.freeze(tls.TLSSocket);
Object.freeze(tls.Server);
Object.freeze(tls);

// 3. node:dgram
const origCreateSocket = dgram.createSocket;
const origDgramConnect = dgram.Socket.prototype.connect;
const origDgramSend = dgram.Socket.prototype.send;

lockProp(dgram, 'createSocket', function createSocket(...args) {
  if (allowedHosts.size === 0) throw denied('udp');
  return origCreateSocket.apply(this, args);
});
lockProp(dgram.Socket.prototype, 'bind', function bind() {
  throw denied('listen');
});
lockProp(dgram.Socket.prototype, 'connect', function connect(port, address, ...rest) {
  const host = typeof address === 'string' ? address : 'localhost';
  assertAllowed(host, port, `${host}:${port}`);
  return origDgramConnect.call(this, port, address, ...rest);
});
lockProp(dgram.Socket.prototype, 'send', function send(...args) {
  if (allowedHosts.size === 0) throw denied('udp');
  const parsed = parseDgramSendArgs(args);
  if (parsed) assertAllowed(parsed.host, parsed.port, parsed.label);
  return origDgramSend.apply(this, args);
});
Object.preventExtensions(dgram.Socket.prototype);
Object.freeze(dgram.Socket);
Object.freeze(dgram);

// 4. node:http & node:https
const origHttpRequest = http.request;
const origHttpGet = http.get;
const origClientRequest = http.ClientRequest;

lockProp(http, 'request', function request(...args) {
  const t = parseHttpArgs(args, 'http:');
  assertAllowed(t.host, t.port, t.label);
  return origHttpRequest.apply(this, args);
});
lockProp(http, 'get', function get(...args) {
  const t = parseHttpArgs(args, 'http:');
  assertAllowed(t.host, t.port, t.label);
  return origHttpGet.apply(this, args);
});
class GuardedClientRequest extends origClientRequest {
  constructor(input, options, cb) {
    const args = options !== undefined ? [input, options, cb] : [input];
    const t = parseHttpArgs(args, 'http:');
    assertAllowed(t.host, t.port, t.label);
    super(input, options, cb);
  }
}
lockProp(http, 'ClientRequest', GuardedClientRequest);
Object.freeze(http);

const origHttpsRequest = https.request;
const origHttpsGet = https.get;
lockProp(https, 'request', function request(...args) {
  const t = parseHttpArgs(args, 'https:');
  assertAllowed(t.host, t.port, t.label);
  return origHttpsRequest.apply(this, args);
});
lockProp(https, 'get', function get(...args) {
  const t = parseHttpArgs(args, 'https:');
  assertAllowed(t.host, t.port, t.label);
  return origHttpsGet.apply(this, args);
});
Object.freeze(https);

// 5. node:http2
const origHttp2Connect = http2.connect;
lockProp(http2, 'connect', function connect(authority, options, listener) {
  if (options && typeof options === 'object' && (options.socketPath || options.path)) {
    throw denied(String(options.socketPath ?? options.path));
  }
  const t = parseUrlTarget(authority, 'https:');
  assertAllowed(t.host, t.port, t.label);
  return origHttp2Connect.call(this, authority, options, listener);
});
Object.freeze(http2);

// 6. node:dns & node:dns/promises
function wrapDnsCallbackFn(origFn, isIpCheck = false) {
  return function guardedDns(target, ...rest) {
    const ok = isIpCheck ? isHostAllowedForDns(target) : isHostAllowedForDns(target);
    if (!ok) {
      const err = denied(String(target ?? 'unknown'));
      const cb = rest.length > 0 && typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined;
      if (cb) {
        process.nextTick(cb, err);
        return;
      }
      throw err;
    }
    return origFn.call(this, target, ...rest);
  };
}

function wrapDnsPromiseFn(origFn) {
  return async function guardedDnsPromise(target, ...rest) {
    if (!isHostAllowedForDns(target)) {
      throw denied(String(target ?? 'unknown'));
    }
    return origFn.call(this, target, ...rest);
  };
}

lockProp(dns, 'lookup', wrapDnsCallbackFn(dns.lookup));
const origLookupService = dns.lookupService;
lockProp(dns, 'lookupService', function lookupService(address, port, cb) {
  if (!isAllowed(address, port)) {
    const err = denied(`${address}:${port}`);
    if (typeof cb === 'function') {
      process.nextTick(cb, err);
      return;
    }
    throw err;
  }
  return origLookupService.call(this, address, port, cb);
});

for (const key of Object.getOwnPropertyNames(dns)) {
  if ((key === 'reverse' || key.startsWith('resolve')) && typeof dns[key] === 'function') {
    lockProp(dns, key, wrapDnsCallbackFn(dns[key], key === 'reverse'));
  }
}
for (const key of Object.getOwnPropertyNames(dns.Resolver.prototype)) {
  if ((key === 'reverse' || key.startsWith('resolve')) && typeof dns.Resolver.prototype[key] === 'function') {
    lockProp(dns.Resolver.prototype, key, wrapDnsCallbackFn(dns.Resolver.prototype[key], key === 'reverse'));
  }
}
Object.preventExtensions(dns.Resolver.prototype);
Object.freeze(dns.Resolver);
Object.freeze(dns);

lockProp(dnsPromises, 'lookup', wrapDnsPromiseFn(dnsPromises.lookup));
const origPromisesLookupService = dnsPromises.lookupService;
lockProp(dnsPromises, 'lookupService', async function lookupService(address, port) {
  assertAllowed(address, port, `${address}:${port}`);
  return origPromisesLookupService.call(this, address, port);
});

for (const key of Object.getOwnPropertyNames(dnsPromises)) {
  if ((key === 'reverse' || key.startsWith('resolve')) && typeof dnsPromises[key] === 'function') {
    lockProp(dnsPromises, key, wrapDnsPromiseFn(dnsPromises[key]));
  }
}
for (const key of Object.getOwnPropertyNames(dnsPromises.Resolver.prototype)) {
  if ((key === 'reverse' || key.startsWith('resolve')) && typeof dnsPromises.Resolver.prototype[key] === 'function') {
    lockProp(dnsPromises.Resolver.prototype, key, wrapDnsPromiseFn(dnsPromises.Resolver.prototype[key]));
  }
}
Object.preventExtensions(dnsPromises.Resolver.prototype);
Object.freeze(dnsPromises.Resolver);
Object.freeze(dnsPromises);

// 7. Global fetch, WebSocket, EventSource
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  lockProp(globalThis, 'fetch', function fetch(input, init) {
    try {
      const t = parseUrlTarget(input, 'http:');
      assertAllowed(t.host, t.port, t.label);
    } catch (err) {
      return Promise.reject(err);
    }
    return origFetch.call(globalThis, input, init);
  });
}

if (typeof globalThis.WebSocket === 'function') {
  const OrigWebSocket = globalThis.WebSocket;
  class GuardedWebSocket extends OrigWebSocket {
    constructor(url, protocols) {
      const t = parseUrlTarget(url, 'ws:');
      assertAllowed(t.host, t.port, t.label);
      if (protocols !== undefined) super(url, protocols);
      else super(url);
    }
  }
  Object.freeze(GuardedWebSocket);
  Object.preventExtensions(GuardedWebSocket.prototype);
  lockProp(globalThis, 'WebSocket', GuardedWebSocket);
}

if (typeof globalThis.EventSource === 'function') {
  const OrigEventSource = globalThis.EventSource;
  class GuardedEventSource extends OrigEventSource {
    constructor(url, eventSourceInitDict) {
      const t = parseUrlTarget(url, 'http:');
      assertAllowed(t.host, t.port, t.label);
      super(url, eventSourceInitDict);
    }
  }
  Object.freeze(GuardedEventSource);
  Object.preventExtensions(GuardedEventSource.prototype);
  lockProp(globalThis, 'EventSource', GuardedEventSource);
}
