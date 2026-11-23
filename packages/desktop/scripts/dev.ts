// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build.ts';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');

function resolveElectronExe(): string {
  const local = join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (existsSync(local)) return local;
  return join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
}

async function run(): Promise<number> {
  const useVite = process.argv.includes('--vite');
  if (!useVite && !existsSync(join(REPO_ROOT, 'packages', 'ui', 'dist', 'index.html'))) {
    const uiRes = await new Promise<number>(resolveExit => {
      const p = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        cwd: join(REPO_ROOT, 'packages', 'ui'),
        stdio: 'inherit',
        windowsHide: true,
      });
      p.on('exit', code => resolveExit(code ?? 1));
    });
    if (uiRes !== 0) return uiRes;
  }

  await buildDesktop();

  const electronExe = resolveElectronExe();
  if (!existsSync(electronExe)) {
    console.error(`electron executable not found at ${electronExe}`);
    return 1;
  }

  const devUiUrl = process.env.CADLLM_DEV_UI_URL?.trim() || (useVite ? 'http://127.0.0.1:5173' : undefined);
  let viteProc: ReturnType<typeof spawn> | undefined;
  if (useVite && !process.env.CADLLM_DEV_UI_URL) {
    viteProc = spawn(
      process.execPath,
      [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173'],
      { cwd: join(REPO_ROOT, 'packages', 'ui'), stdio: 'inherit', windowsHide: true },
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://127.0.0.1:5173/');
        if (res.ok) break;
      } catch {
        // Wait for Vite dev server to start
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  try {
    const exitCode = await new Promise<number>(resolveExit => {
      const child = spawn(electronExe, [join(DESKTOP_DIR, 'dist', 'main.mjs'), ...process.argv.slice(2).filter(a => a !== '--vite')], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(devUiUrl ? { CADLLM_DEV_UI_URL: devUiUrl } : {}),
        },
      });
      child.on('exit', code => resolveExit(code ?? 0));
    });
    return exitCode;
  } finally {
    if (viteProc && viteProc.exitCode === null) {
      viteProc.kill();
    }
  }
}

run().then(
  code => { process.exitCode = code; },
  err => { console.error(err); process.exitCode = 1; },
);
