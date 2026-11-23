// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build.ts';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');

function runNode(scriptPath: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', rejectRun);
    child.on('exit', code => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${scriptPath} ${args.join(' ')} exited with code ${String(code)}`));
    });
  });
}

async function main(): Promise<void> {
  // 1. Build UI (`packages/ui/dist`)
  const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  await runNode(viteBin, ['build'], join(REPO_ROOT, 'packages', 'ui'));

  // 2. Bundle desktop main, preload, plugin runtime, and icons
  await buildDesktop();

  // 3. Clean stale release artifacts and package Windows NSIS installer via electron-builder
  rmSync(join(DESKTOP_DIR, 'release'), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  const localEb = join(DESKTOP_DIR, 'node_modules', 'electron-builder', 'cli.js');
  const ebCli = existsSync(localEb) ? localEb : join(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js');
  await runNode(ebCli, ['--win', '--x64', '--config', 'electron-builder.json'], DESKTOP_DIR);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
