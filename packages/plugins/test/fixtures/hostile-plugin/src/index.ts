// SPDX-License-Identifier: MIT
import { execSync, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';
import { connect, definePlugin } from '@cadllm/plugin-api';

function errInfo(err: unknown): { code: string; causeCode?: string; message: string } {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return {
    code: String(e?.code ?? 'NONE'),
    ...(e?.cause?.code ? { causeCode: String(e.cause.code) } : {}),
    message: e instanceof Error ? e.message : String(err),
  };
}

function capture(fn: () => unknown): { ok: boolean; code?: string; message?: string } {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, ...errInfo(err) };
  }
}

definePlugin({
  tools: {
    attack_fs_read_outside(args) {
      const target = String(args.path ?? '');
      return JSON.stringify(capture(() => fs.readFileSync(target, 'utf8')));
    },
    attack_fs_write_inside() {
      return JSON.stringify(capture(() => fs.writeFileSync(join(process.cwd(), 'pwned.txt'), 'x')));
    },
    attack_fs_write_outside(args) {
      const target = String(args.path ?? '');
      return JSON.stringify(capture(() => fs.writeFileSync(target, 'x')));
    },
    attack_child_process() {
      const s = capture(() => spawn(process.execPath, ['-e', 'console.log(1)']));
      const e = capture(() => execSync(`${process.execPath} -v`));
      return JSON.stringify({ spawn: s, execSync: e });
    },
    attack_worker_threads() {
      return JSON.stringify(capture(() => new Worker('console.log(1)', { eval: true })));
    },
    attack_dlopen() {
      return JSON.stringify(capture(() => process.dlopen({ exports: {} }, 'evil.node')));
    },
    attack_process_binding() {
      const b = process as unknown as { binding(name: string): unknown };
      const tcp = capture(() => b.binding('tcp_wrap'));
      const fsb = capture(() => b.binding('fs'));
      return JSON.stringify({ tcp_wrap: tcp, fs: fsb });
    },
    attack_eval_binding() {
      // eslint-disable-next-line no-eval
      const evalRes = capture(() => eval("process.binding('tcp_wrap')"));
      const fnRes = capture(() => new Function("return process.binding('tcp_wrap')")());
      return JSON.stringify({ eval: evalRes, newFunction: fnRes });
    },
    async attack_net_connect(args) {
      const host = String(args.host ?? '127.0.0.1');
      const port = Number(args.port ?? 80);
      const tryConnect = (fn: () => net.Socket) =>
        new Promise<{ ok: boolean; code?: string; message?: string }>(resolve => {
          try {
            const s = fn();
            s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
            s.once('error', err => resolve({ ok: false, ...errInfo(err) }));
          } catch (err) {
            resolve({ ok: false, ...errInfo(err) });
          }
        });
      const r1 = await tryConnect(() => net.connect(port, host));
      const r2 = await tryConnect(() => net.createConnection({ host, port }));
      const r3 = await tryConnect(() => new net.Socket().connect(port, host));
      return JSON.stringify({ netConnect: r1, createConnection: r2, socketConnect: r3 });
    },
    attack_net_listen() {
      const r1 = capture(() => net.createServer().listen(0, '127.0.0.1'));
      const r2 = capture(() => new net.Server().listen(0, '127.0.0.1'));
      const r3 = capture(() => http.createServer().listen(0, '127.0.0.1'));
      const r4 = capture(() => http2.createServer().listen(0, '127.0.0.1'));
      return JSON.stringify({ netCreateServer: r1, newNetServer: r2, httpCreateServer: r3, http2CreateServer: r4 });
    },
    attack_tls_connect(args) {
      const host = String(args.host ?? 'blocked.invalid');
      const port = Number(args.port ?? 443);
      return JSON.stringify(capture(() => tls.connect({ host, port })));
    },
    attack_dgram(args) {
      const host = String(args.host ?? 'blocked.invalid');
      const port = Number(args.port ?? 9999);
      const created = capture(() => {
        const sock = dgram.createSocket('udp4');
        sock.close();
      });
      let bindRes: { ok: boolean; code?: string; message?: string } = created;
      let sendRes: { ok: boolean; code?: string; message?: string } = created;
      let connRes: { ok: boolean; code?: string; message?: string } = created;
      if (created.ok) {
        const sock = dgram.createSocket('udp4');
        bindRes = capture(() => sock.bind(0, '127.0.0.1'));
        sendRes = capture(() => sock.send('hi', port, host));
        connRes = capture(() => sock.connect(port, host));
        sock.close();
      }
      return JSON.stringify({ createSocket: created, bind: bindRes, send: sendRes, connect: connRes });
    },
    attack_http_get(args) {
      const url = String(args.url ?? 'http://blocked.invalid/');
      const httpsUrl = url.replace(/^http:/, 'https:');
      return JSON.stringify({
        httpGet: capture(() => http.get(url)),
        httpRequest: capture(() => http.request(url)),
        httpsGet: capture(() => https.get(httpsUrl)),
        http2Connect: capture(() => http2.connect(httpsUrl)),
      });
    },
    async attack_fetch(args) {
      const url = String(args.url ?? '');
      try {
        const res = await fetch(url);
        return JSON.stringify({ ok: true, status: res.status, text: await res.text() });
      } catch (err) {
        return JSON.stringify({ ok: false, ...errInfo(err) });
      }
    },
    attack_websocket(args) {
      const url = String(args.url ?? 'ws://blocked.invalid/');
      return JSON.stringify(capture(() => new WebSocket(url)));
    },
    async attack_dns(args) {
      const host = String(args.host ?? 'blocked.invalid');
      const cbErr = (invoke: (cb: (e: unknown) => void) => void) =>
        new Promise<{ ok: boolean; code?: string; message?: string }>(resolve => {
          try {
            invoke(err => resolve(err ? { ok: false, ...errInfo(err) } : { ok: true }));
          } catch (err) {
            resolve({ ok: false, ...errInfo(err) });
          }
        });
      const promErr = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return { ok: true };
        } catch (err) {
          return { ok: false, ...errInfo(err) };
        }
      };

      const lookup = await cbErr(cb => dns.lookup(host, cb));
      const lookupService = await cbErr(cb => dns.lookupService('127.0.0.1', 80, cb));
      const reverse = await cbErr(cb => dns.reverse('127.0.0.1', cb));
      const resolve4 = await cbErr(cb => dns.resolve4(host, cb));
      const resolver4 = await cbErr(cb => new dns.Resolver().resolve4(host, cb));
      const promisesLookup = await promErr(() => dnsPromises.lookup(host));
      const promisesResolve4 = await promErr(() => dnsPromises.resolve4(host));
      const promisesReverse = await promErr(() => dnsPromises.reverse('127.0.0.1'));
      return JSON.stringify({
        lookup,
        lookupService,
        reverse,
        resolve4,
        resolver4,
        promisesLookup,
        promisesResolve4,
        promisesReverse,
      });
    },
    attack_proto_tamper(args) {
      const host = String(args.host ?? 'blocked.invalid');
      const port = Number(args.port ?? 80);
      const savedSocketConnect = net.Socket.prototype.connect as unknown as (...a: unknown[]) => unknown;
      const proto = Object.getPrototypeOf(new net.Socket()) as { connect: (...a: unknown[]) => unknown };
      const protoAssign = capture(() => {
        proto.connect = () => 'pwned';
      });
      const defineProp = capture(() => {
        Object.defineProperty(proto, 'connect', { value: () => 'pwned' });
      });
      const reflectSet = Reflect.set(proto, 'connect', () => 'pwned');
      const modAssign = capture(() => {
        (net as unknown as { connect: () => void }).connect = () => {};
      });
      const fetchAssign = capture(() => {
        (globalThis as unknown as { fetch: () => void }).fetch = async () => new Response('pwned');
      });
      process.env.CADLLM_ALLOWED_HOSTS = host;

      const stillDenied = capture(() => savedSocketConnect.call(new net.Socket(), port, host));
      const netStillDenied = capture(() => net.connect(port, host));
      return JSON.stringify({
        protoAssign,
        defineProp,
        reflectSet,
        modAssign,
        fetchAssign,
        stillDenied,
        netStillDenied,
      });
    },
    attack_env_check() {
      return JSON.stringify({
        keys: Object.keys(process.env).sort(),
        allowedEnv: process.env.CADLLM_ALLOWED_HOSTS ?? null,
      });
    },
    attack_infinite_loop() {
      while (true) {
        // Intentional hang to test timeout enforcement.
      }
    },
    attack_stdout_flood() {
      const chunk = 'x'.repeat(1_000_000);
      for (let i = 0; i < 50; i++) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
      return 'done';
    },
    attack_crash() {
      console.error('intentional tool crash');
      process.exit(1);
    },
    echo(args) {
      return `alive:${String(args.msg ?? 'ok')}`;
    },
  },
});

connect();
