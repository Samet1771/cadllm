// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHost } from '../src/index.ts';

const hostileDir = resolve(import.meta.dirname, 'fixtures/hostile-plugin');
const crashDir = resolve(import.meta.dirname, 'fixtures/crash-startup');

describe('Sandbox escape & resilience suite', () => {
  let server: http.Server;
  let serverPort: number;
  let otherServer: http.Server;
  let otherPort: number;
  let tempDir: string;
  let outsideSecretFile: string;
  let outsideWriteFile: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cadllm-escape-'));
    outsideSecretFile = join(tempDir, 'secret.txt');
    outsideWriteFile = join(tempDir, 'escape-write.txt');
    writeFileSync(outsideSecretFile, 'TOP_SECRET_DATA', 'utf8');

    server = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      if (req.url === '/redirect-localhost') {
        res.writeHead(302, { Location: `http://localhost:${serverPort}/ping` });
        res.end();
        return;
      }
      res.end('pong');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    serverPort = (server.address() as { port: number }).port;

    otherServer = http.createServer((_req, res) => {
      res.setHeader('Connection', 'close');
      res.end('other');
    });
    await new Promise<void>(r => otherServer.listen(0, '127.0.0.1', r));
    otherPort = (otherServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    otherServer?.closeAllConnections();
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    await new Promise<void>(r => (otherServer ? otherServer.close(() => r()) : r()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('denies every filesystem, process, native, network, and prototype-tampering attack without grants', async () => {
    process.env.CADLLM_TEST_SECRET = 'MUST_NOT_LEAK';
    const host = new PluginHost({ timeoutMs: 700, maxOutputBytes: 256 * 1024 });
    try {
      host.load(hostileDir, { grants: [] });

      // 1. Minimal env: no ambient secrets leaked, CADLLM_ALLOWED_HOSTS deleted
      const envRes = JSON.parse(await host.callTool('attack_env_check')) as {
        keys: string[];
        allowedEnv: string | null;
      };
      expect(envRes.keys).not.toContain('CADLLM_TEST_SECRET');
      expect(envRes.allowedEnv).toBeNull();

      // 2. fs.readFileSync outside plugin dir -> ERR_ACCESS_DENIED
      const readRes = JSON.parse(
        await host.callTool('attack_fs_read_outside', { path: outsideSecretFile }),
      ) as { ok: boolean; code: string };
      expect(readRes.ok).toBe(false);
      expect(readRes.code).toBe('ERR_ACCESS_DENIED');

      // 3. fs.writeFileSync inside & outside plugin dir -> ERR_ACCESS_DENIED
      const writeIn = JSON.parse(await host.callTool('attack_fs_write_inside')) as { ok: boolean; code: string };
      expect(writeIn.ok).toBe(false);
      expect(writeIn.code).toBe('ERR_ACCESS_DENIED');

      const writeOut = JSON.parse(
        await host.callTool('attack_fs_write_outside', { path: outsideWriteFile }),
      ) as { ok: boolean; code: string };
      expect(writeOut.ok).toBe(false);
      expect(writeOut.code).toBe('ERR_ACCESS_DENIED');

      // 4. child_process spawn / execSync -> ERR_ACCESS_DENIED
      const cpRes = JSON.parse(await host.callTool('attack_child_process')) as {
        spawn: { ok: boolean; code: string };
        execSync: { ok: boolean; code: string };
      };
      expect(cpRes.spawn.ok).toBe(false);
      expect(cpRes.spawn.code).toBe('ERR_ACCESS_DENIED');
      expect(cpRes.execSync.ok).toBe(false);
      expect(cpRes.execSync.code).toBe('ERR_ACCESS_DENIED');

      // 5. worker_threads.Worker -> ERR_ACCESS_DENIED
      const wtRes = JSON.parse(await host.callTool('attack_worker_threads')) as { ok: boolean; code: string };
      expect(wtRes.ok).toBe(false);
      expect(wtRes.code).toBe('ERR_ACCESS_DENIED');

      // 6. process.dlopen -> ERR_DLOPEN_DISABLED
      const dlRes = JSON.parse(await host.callTool('attack_dlopen')) as { ok: boolean; code: string };
      expect(dlRes.ok).toBe(false);
      expect(dlRes.code).toBe('ERR_DLOPEN_DISABLED');

      // 7. process.binding('tcp_wrap') & process.binding('fs') -> ERR_ACCESS_DENIED
      const bindRes = JSON.parse(await host.callTool('attack_process_binding')) as {
        tcp_wrap: { ok: boolean; code: string };
        fs: { ok: boolean; code: string };
      };
      expect(bindRes.tcp_wrap.ok).toBe(false);
      expect(bindRes.tcp_wrap.code).toBe('ERR_ACCESS_DENIED');
      expect(bindRes.fs.ok).toBe(false);
      expect(bindRes.fs.code).toBe('ERR_ACCESS_DENIED');

      // 8. eval / new Function reaching process.binding -> ERR_ACCESS_DENIED
      const evalRes = JSON.parse(await host.callTool('attack_eval_binding')) as {
        eval: { ok: boolean; code: string };
        newFunction: { ok: boolean; code: string };
      };
      expect(evalRes.eval.ok).toBe(false);
      expect(evalRes.eval.code).toBe('ERR_ACCESS_DENIED');
      expect(evalRes.newFunction.ok).toBe(false);
      expect(evalRes.newFunction.code).toBe('ERR_ACCESS_DENIED');

      // 9. net.connect / createConnection / Socket#connect to ungranted 127.0.0.1 -> ERR_NETWORK_ACCESS_DENIED
      const netRes = JSON.parse(
        await host.callTool('attack_net_connect', { host: '127.0.0.1', port: serverPort }),
      ) as {
        netConnect: { ok: boolean; code: string };
        createConnection: { ok: boolean; code: string };
        socketConnect: { ok: boolean; code: string };
      };
      expect(netRes.netConnect.ok).toBe(false);
      expect(netRes.netConnect.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      expect(netRes.createConnection.ok).toBe(false);
      expect(netRes.createConnection.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      expect(netRes.socketConnect.ok).toBe(false);
      expect(netRes.socketConnect.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 10. net.Server#listen (and http/http2 createServer#listen) -> ERR_NETWORK_ACCESS_DENIED
      const listenRes = JSON.parse(await host.callTool('attack_net_listen')) as Record<
        string,
        { ok: boolean; code: string }
      >;
      for (const k of ['netCreateServer', 'newNetServer', 'httpCreateServer', 'http2CreateServer']) {
        expect(listenRes[k]?.ok).toBe(false);
        expect(listenRes[k]?.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      }

      // 11. tls.connect -> ERR_NETWORK_ACCESS_DENIED
      const tlsRes = JSON.parse(
        await host.callTool('attack_tls_connect', { host: 'blocked.invalid', port: 443 }),
      ) as { ok: boolean; code: string };
      expect(tlsRes.ok).toBe(false);
      expect(tlsRes.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 12. dgram.createSocket -> ERR_NETWORK_ACCESS_DENIED
      const dgramRes = JSON.parse(
        await host.callTool('attack_dgram', { host: 'blocked.invalid', port: 9999 }),
      ) as { createSocket: { ok: boolean; code: string } };
      expect(dgramRes.createSocket.ok).toBe(false);
      expect(dgramRes.createSocket.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 13. http.get, http.request, https.get, http2.connect -> ERR_NETWORK_ACCESS_DENIED
      const httpRes = JSON.parse(
        await host.callTool('attack_http_get', { url: `http://127.0.0.1:${serverPort}/ping` }),
      ) as Record<string, { ok: boolean; code: string }>;
      for (const k of ['httpGet', 'httpRequest', 'httpsGet', 'http2Connect']) {
        expect(httpRes[k]?.ok).toBe(false);
        expect(httpRes[k]?.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      }

      // 14. global fetch -> ERR_NETWORK_ACCESS_DENIED
      const fetchRes = JSON.parse(
        await host.callTool('attack_fetch', { url: `http://127.0.0.1:${serverPort}/ping` }),
      ) as { ok: boolean; code: string };
      expect(fetchRes.ok).toBe(false);
      expect(fetchRes.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 15. global WebSocket -> ERR_NETWORK_ACCESS_DENIED
      const wsRes = JSON.parse(
        await host.callTool('attack_websocket', { url: `ws://127.0.0.1:${serverPort}/` }),
      ) as { ok: boolean; code: string };
      expect(wsRes.ok).toBe(false);
      expect(wsRes.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 16. dns.lookup, lookupService, reverse, resolve4, Resolver.resolve4, dns.promises.* -> ERR_NETWORK_ACCESS_DENIED
      const dnsRes = JSON.parse(await host.callTool('attack_dns', { host: 'blocked.invalid' })) as Record<
        string,
        { ok: boolean; code: string }
      >;
      for (const k of [
        'lookup',
        'lookupService',
        'reverse',
        'resolve4',
        'resolver4',
        'promisesLookup',
        'promisesResolve4',
        'promisesReverse',
      ]) {
        expect(dnsRes[k]?.ok).toBe(false);
        expect(dnsRes[k]?.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      }

      // 17. Prototype / saved-ref / Object.getPrototypeOf / env tampering -> denied & guard holds
      const tamperRes = JSON.parse(
        await host.callTool('attack_proto_tamper', { host: 'blocked.invalid', port: 80 }),
      ) as {
        protoAssign: { ok: boolean };
        defineProp: { ok: boolean };
        reflectSet: boolean;
        modAssign: { ok: boolean };
        fetchAssign: { ok: boolean };
        stillDenied: { ok: boolean; code: string };
        netStillDenied: { ok: boolean; code: string };
      };
      expect(tamperRes.protoAssign.ok).toBe(false);
      expect(tamperRes.defineProp.ok).toBe(false);
      expect(tamperRes.reflectSet).toBe(false);
      expect(tamperRes.modAssign.ok).toBe(false);
      expect(tamperRes.fetchAssign.ok).toBe(false);
      expect(tamperRes.stillDenied.ok).toBe(false);
      expect(tamperRes.stillDenied.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      expect(tamperRes.netStillDenied.ok).toBe(false);
      expect(tamperRes.netStillDenied.code).toBe('ERR_NETWORK_ACCESS_DENIED');
    } finally {
      delete process.env.CADLLM_TEST_SECRET;
      await host.dispose();
    }
  });

  it('kills infinite loop on timeout, kills 50 MB stdout flood, restarts lazily on crash, and marks failed after repeated crashes', async () => {
    const host = new PluginHost({
      timeoutMs: 400,
      maxOutputBytes: 256 * 1024,
      maxCrashRestarts: 3,
      crashBackoffMs: 40,
    });
    try {
      host.load(hostileDir, { grants: [] });
      expect(await host.callTool('echo', { msg: '1' })).toBe('alive:1');

      // Infinite loop -> killed on timeout -> next call recovers lazily
      await expect(host.callTool('attack_infinite_loop')).rejects.toThrow(/timed out/i);
      expect(await host.callTool('echo', { msg: 'after-timeout' })).toBe('alive:after-timeout');

      // 50 MB stdout flood -> killed on output limit -> next call recovers lazily
      await expect(host.callTool('attack_stdout_flood')).rejects.toThrow(/max output limit/i);
      expect(await host.callTool('echo', { msg: 'after-flood' })).toBe('alive:after-flood');

      // Single crash -> killed/exited -> next call restarts lazily
      await expect(host.callTool('attack_crash')).rejects.toThrow(/exited unexpectedly/i);
      expect(await host.callTool('echo', { msg: 'after-crash' })).toBe('alive:after-crash');

      // 3 consecutive crashes -> backoff + marked failed with reason visible in list()
      const t0 = Date.now();
      await expect(host.callTool('attack_crash')).rejects.toThrow(/exited unexpectedly/i);
      await expect(host.callTool('attack_crash')).rejects.toThrow(/exited unexpectedly/i);
      await expect(host.callTool('attack_crash')).rejects.toThrow(/exited unexpectedly/i);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(30);

      const listed = host.list();
      expect(listed[0]?.status).toBe('failed');
      expect(listed[0]?.error).toMatch(/exited unexpectedly/);
      expect(listed[0]?.error).toMatch(/intentional tool crash/);

      // Once failed, subsequent calls fail immediately without spawning
      await expect(host.callTool('echo')).rejects.toThrow(/failed/);

      // Startup-crashing plugin also hits backoff and marks failed
      host.load(crashDir);
      await expect(host.callTool('ping')).rejects.toThrow(/exited unexpectedly/);
      await expect(host.callTool('ping')).rejects.toThrow(/exited unexpectedly/);
      await expect(host.callTool('ping')).rejects.toThrow(/exited unexpectedly/);
      const crashEntry = host.list().find(p => p.manifest.id === 'org.test.crash');
      expect(crashEntry?.status).toBe('failed');
      expect(crashEntry?.error).toMatch(/intentional startup crash/);
    } finally {
      await host.dispose();
    }
  });

  it('allows granted net:127.0.0.1 and exact port grants while blocking localhost, redirects, and listen()', async () => {
    const host = new PluginHost({ timeoutMs: 2000 });
    try {
      // Grant net:127.0.0.1 (any port on 127.0.0.1)
      host.load(hostileDir, { grants: ['net:127.0.0.1'] });

      // net.connect / createConnection / Socket#connect to 127.0.0.1 succeeds
      const netOk = JSON.parse(
        await host.callTool('attack_net_connect', { host: '127.0.0.1', port: serverPort }),
      ) as { netConnect: { ok: boolean }; createConnection: { ok: boolean }; socketConnect: { ok: boolean } };
      expect(netOk.netConnect.ok).toBe(true);
      expect(netOk.createConnection.ok).toBe(true);
      expect(netOk.socketConnect.ok).toBe(true);

      // fetch to 127.0.0.1 succeeds
      const fetchOk = JSON.parse(
        await host.callTool('attack_fetch', { url: `http://127.0.0.1:${serverPort}/ping` }),
      ) as { ok: boolean; text: string };
      expect(fetchOk.ok).toBe(true);
      expect(fetchOk.text).toBe('pong');

      // fetch to localhost is STILL blocked
      const fetchLocalhost = JSON.parse(
        await host.callTool('attack_fetch', { url: `http://localhost:${serverPort}/ping` }),
      ) as { ok: boolean; code: string };
      expect(fetchLocalhost.ok).toBe(false);
      expect(fetchLocalhost.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // 302 redirect from 127.0.0.1 -> localhost is blocked at socket/lookup layer
      const fetchRedir = JSON.parse(
        await host.callTool('attack_fetch', { url: `http://127.0.0.1:${serverPort}/redirect-localhost` }),
      ) as { ok: boolean; causeCode?: string };
      expect(fetchRedir.ok).toBe(false);
      expect(fetchRedir.causeCode).toBe('ERR_NETWORK_ACCESS_DENIED');

      // listen() is STILL denied even with net:127.0.0.1 granted
      const listenDenied = JSON.parse(await host.callTool('attack_net_listen')) as {
        netCreateServer: { ok: boolean; code: string };
      };
      expect(listenDenied.netCreateServer.ok).toBe(false);
      expect(listenDenied.netCreateServer.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // dgram bind is denied, and send to ungranted host is denied
      const dgramCheck = JSON.parse(
        await host.callTool('attack_dgram', { host: 'blocked.invalid', port: 9999 }),
      ) as {
        bind: { ok: boolean; code: string };
        send: { ok: boolean; code: string };
        connect: { ok: boolean; code: string };
      };
      expect(dgramCheck.bind.ok).toBe(false);
      expect(dgramCheck.bind.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      expect(dgramCheck.send.ok).toBe(false);
      expect(dgramCheck.send.code).toBe('ERR_NETWORK_ACCESS_DENIED');
      expect(dgramCheck.connect.ok).toBe(false);
      expect(dgramCheck.connect.code).toBe('ERR_NETWORK_ACCESS_DENIED');

      // Port-specific grant test: only serverPort allowed, otherPort denied
      const portPluginDir = mkdtempSync(join(tempDir, 'port-plug-'));
      writeFileSync(
        join(portPluginDir, 'plugin.json'),
        JSON.stringify({
          id: 'org.test.port',
          name: 'Port Plugin',
          version: '1.0.0',
          engine: '^1.0.0',
          license: 'MIT',
          main: 'index.mjs',
          permissions: [`net:127.0.0.1:${serverPort}`],
          contributes: { tools: [{ name: 'hit', summary: 'fetch url' }] },
        }),
      );
      writeFileSync(
        join(portPluginDir, 'index.mjs'),
        `import { connect, definePlugin } from '@cadllm/plugin-api';
        definePlugin({
          tools: {
            async hit(args) {
              try {
                const res = await fetch(String(args.url));
                return 'ok:' + await res.text();
              } catch (e) {
                return 'err:' + (e.code || e.cause?.code || e.message);
              }
            }
          }
        });
        connect();`,
      );
      host.load(portPluginDir, { grants: [`net:127.0.0.1:${serverPort}`] });
      expect(await host.callTool('hit', { url: `http://127.0.0.1:${serverPort}/ping` })).toBe('ok:pong');
      expect(await host.callTool('hit', { url: `http://127.0.0.1:${otherPort}/ping` })).toBe(
        'err:ERR_NETWORK_ACCESS_DENIED',
      );
    } finally {
      await host.dispose();
    }
  });

  it('allows explicitly granted fs:read and fs:write paths while denying ungranted paths', async () => {
    const fsHost = new PluginHost({ timeoutMs: 2000 });
    const plugDir = mkdtempSync(join(tempDir, 'fs-plug-'));
    const grantedReadDir = join(tempDir, 'granted-read');
    const grantedWriteDir = join(tempDir, 'granted-write');
    const ungrantedRead = join(tempDir, 'ungranted.txt');
    try {
      rmSync(grantedReadDir, { recursive: true, force: true });
      rmSync(grantedWriteDir, { recursive: true, force: true });
      const { mkdirSync, readFileSync } = await import('node:fs');
      mkdirSync(grantedReadDir, { recursive: true });
      mkdirSync(grantedWriteDir, { recursive: true });
      writeFileSync(join(grantedReadDir, 'ok.txt'), 'allowed-read', 'utf8');
      writeFileSync(ungrantedRead, 'forbidden-read', 'utf8');

      writeFileSync(
        join(plugDir, 'plugin.json'),
        JSON.stringify({
          id: 'org.test.fsgrant',
          name: 'FS Grant Plugin',
          version: '1.0.0',
          engine: '^1.0.0',
          license: 'MIT',
          main: 'index.mjs',
          permissions: [`fs:read:${grantedReadDir}`, `fs:write:${grantedWriteDir}`],
          contributes: { tools: [{ name: 'test_fs', summary: 'test granted fs' }] },
        }),
      );
      writeFileSync(
        join(plugDir, 'index.mjs'),
        `import fs from 'node:fs';
        import { join } from 'node:path';
        import { connect, definePlugin } from '@cadllm/plugin-api';
        definePlugin({
          tools: {
            test_fs(args) {
              const okRead = fs.readFileSync(join(String(args.readDir), 'ok.txt'), 'utf8');
              fs.writeFileSync(join(String(args.writeDir), 'out.txt'), 'allowed-write', 'utf8');
              let deniedCode = 'NONE';
              try {
                fs.readFileSync(String(args.deniedFile), 'utf8');
              } catch (e) {
                deniedCode = e.code;
              }
              return JSON.stringify({ okRead, deniedCode });
            }
          }
        });
        connect();`,
      );

      fsHost.load(plugDir, { grants: [`fs:read:${grantedReadDir}`, `fs:write:${grantedWriteDir}`] });
      const res = JSON.parse(
        await fsHost.callTool('test_fs', {
          readDir: grantedReadDir,
          writeDir: grantedWriteDir,
          deniedFile: ungrantedRead,
        }),
      ) as { okRead: string; deniedCode: string };
      expect(res.okRead).toBe('allowed-read');
      expect(res.deniedCode).toBe('ERR_ACCESS_DENIED');
      expect(readFileSync(join(grantedWriteDir, 'out.txt'), 'utf8')).toBe('allowed-write');
    } finally {
      await fsHost.dispose();
    }
  });
});
