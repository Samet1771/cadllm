// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');

function resolveTarget(useDevElectron: boolean): { command: string; args: string[]; label: string } {
  if (!useDevElectron) {
    const unpackedExe = join(DESKTOP_DIR, 'release', 'win-unpacked', 'CadLLM.exe');
    if (existsSync(unpackedExe)) {
      return { command: unpackedExe, args: [], label: unpackedExe };
    }
  }
  const localElectron = join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electronExe = existsSync(localElectron)
    ? localElectron
    : join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return {
    command: electronExe,
    args: [join(DESKTOP_DIR, 'dist', 'main.mjs')],
    label: `${electronExe} dist/main.mjs`,
  };
}

async function waitForServeJson(serveFile: string, timeoutMs = 15_000): Promise<{ port: number; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(serveFile)) {
      try {
        const parsed = JSON.parse(readFileSync(serveFile, 'utf8')) as { port?: unknown; pid?: unknown };
        if (typeof parsed.port === 'number' && parsed.port > 0 && typeof parsed.pid === 'number') {
          return { port: parsed.port, pid: parsed.pid };
        }
      } catch {
        // Retry if file is still being written
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${serveFile}`);
}

async function wsCall(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(wsUrl);
    ws.once('error', rejectCall);
    ws.once('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) rejectCall(new Error(msg.error.message));
      else resolveCall(msg.result);
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // Wait for HTTP server listen
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}/health`);
}

async function main(): Promise<void> {
  const useDev = process.argv.includes('--dev');
  const target = resolveTarget(useDev);
  if (!existsSync(target.command)) {
    throw new Error(`Smoke target executable not found: ${target.command}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'cadllm-desktop-smoke-'));
  const stateDir = join(tempRoot, 'state');
  const userDataDir = join(tempRoot, 'userdata');
  const workDir = join(tempRoot, 'work');
  const quitFile = join(tempRoot, 'quit.signal');
  const serveFile = join(stateDir, 'serve.json');

  const child = spawn(target.command, target.args, {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      CADLLM_STATE_DIR: stateDir,
      CADLLM_DESKTOP_USER_DATA: userDataDir,
      CADLLM_ROOT: workDir,
      CADLLM_HEADLESS: '1',
      CADLLM_HEADLESS_QUIT_FILE: quitFile,
    },
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  try {
    console.log(`launch: ${target.label}`);
    const serveInfo = await waitForServeJson(serveFile);
    const baseUrl = `http://127.0.0.1:${serveInfo.port}`;
    console.log(`serve.json: port=${serveInfo.port} pid=${serveInfo.pid}`);

    await waitForHealth(baseUrl);
    console.log(`health: GET ${baseUrl}/health -> 200 {"ok":true}`);

    const uiRes = await fetch(`${baseUrl}/`);
    const uiHtml = await uiRes.text();
    if (!uiRes.ok || !uiHtml.includes('<div id="root">') || uiHtml.includes('CadLLM UI not built')) {
      throw new Error(`Unexpected UI HTML response (status ${uiRes.status})`);
    }
    console.log(`ui: GET ${baseUrl}/ -> 200 (${uiHtml.length} bytes, built UI verified)`);

    const client = new Client({ name: 'desktop-smoke', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
    await client.connect(transport);
    try {
      const findRes = await client.callTool({ name: 'find', arguments: { q: 'led', limit: 2 } });
      const findText = (findRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      console.log(`mcp find: ${findText.split(/\r?\n/)[0]}`);

      const editRes = await client.callTool({
        name: 'edit',
        arguments: {
          cnl: 'V1 dc_supply 5V; R1 res 1k; C1 cap 1u; D1 led red; VCC: V1.+ R1.1; OUT: R1.2 C1.1 D1.A; GND: C1.2 D1.K V1.-',
        },
      });
      const editText = (editRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      console.log(`mcp edit: ${editText}`);

      const spiceRes = await client.callTool({
        name: 'sim',
        arguments: { run: 'tran 2ms probes=V(OUT)' },
      });
      const spiceText = (spiceRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      if (spiceRes.isError) throw new Error(`spice tran failed: ${spiceText}`);
      console.log(`mcp sim (eecircuit-engine WASM): ${spiceText.replace(/\r?\n/g, ' | ')}`);

      const renderRes = await client.callTool({
        name: 'render',
        arguments: { view: 'sch', width: 320 },
      });
      const renderContent = renderRes.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const pngBytes = Buffer.from(renderContent[1]?.data ?? '', 'base64');
      if (pngBytes.subarray(1, 4).toString('ascii') !== 'PNG') {
        throw new Error('render did not return a valid PNG via @resvg/resvg-js');
      }
      console.log(`mcp render (@resvg/resvg-js): ${renderContent[0]?.text} (${pngBytes.byteLength} bytes PNG)`);

      const exportRes = await client.callTool({
        name: 'export',
        arguments: { format: 'fab' },
      });
      const exportText = (exportRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      if (exportRes.isError) throw new Error(`export fab failed: ${exportText}`);
      console.log(`mcp export (fflate): ${exportText.replace(/\r?\n/g, ' | ')}`);

      // Verify sandboxed code plugin runtime inside packaged app (registry + fflate + ELECTRON_RUN_AS_NODE + --permission)
      const wsUrl = `${baseUrl.replace(/^http:/, 'ws:')}/ws`;
      await wsCall(wsUrl, 'plugins.install', { id: 'org.cadllm.example-sensors' });
      const extListRes = await client.callTool({ name: 'ext', arguments: { op: 'list' } });
      const extListText = (extListRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      const extCallRes = await client.callTool({
        name: 'ext',
        arguments: { op: 'call', name: 'calc_divider', args: { vin: 5, vout: 3.3 } },
      });
      const extCallText = (extCallRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      if (extCallRes.isError) throw new Error(`plugin ext call failed: ${extCallText}`);
      console.log(`mcp ext (sandboxed plugin under Electron): ${extListText.split(/\r?\n/)[0]} -> ${extCallText}`);

      // Verify avr8js + arduino-cli discovery / clear missing error
      await client.callTool({ name: 'project', arguments: { op: 'new', name: 'mcucheck' } });
      const mcuEditRes = await client.callTool({
        name: 'edit',
        arguments: {
          cnl: 'U1 arduino_uno; R1 res 220; D1 led red; D13: R1.1 U1.D13; LA: R1.2 D1.A; GND: D1.K U1.GND',
          code: { ref: 'U1', text: 'void setup(){pinMode(13,OUTPUT);} void loop(){digitalWrite(13,HIGH);delay(2);digitalWrite(13,LOW);delay(2);}' },
        },
      });
      if (mcuEditRes.isError) {
        const msg = (mcuEditRes.content as { text?: string }[])[0]?.text ?? '';
        throw new Error(`mcu edit failed: ${msg}`);
      }
      const mcuRes = await client.callTool({
        name: 'sim',
        arguments: { run: 'run 10ms probes=D13' },
      });
      const mcuText = (mcuRes.content as { type: string; text?: string }[])[0]?.text ?? '';
      if (mcuRes.isError) {
        if (!mcuText.includes('arduino-cli not found')) {
          throw new Error(`unexpected avr8js/arduino-cli error: ${mcuText}`);
        }
        console.log(`mcp sim (arduino-cli missing error): ${mcuText.split(/\r?\n/)[0]}`);
      } else {
        console.log(`mcp sim (avr8js + arduino-cli): ${mcuText.replace(/\r?\n/g, ' | ')}`);
      }
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error(`Timed out waiting for app exit\n${stderrTail}`)), 10_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });

    writeFileSync(quitFile, 'quit\n');
    const exited = await exitPromise;
    console.log(`quit: exited code=${String(exited.code)} signal=${String(exited.signal)}`);

    if (existsSync(serveFile)) {
      throw new Error(`serve.json was NOT removed after quit: ${serveFile}`);
    }
    console.log('cleanup: serve.json removed confirmed');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>(resolveExit => {
        const t = setTimeout(resolveExit, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolveExit();
        });
      });
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Ignore Windows Chromium file-lock leftovers in temp directory
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
