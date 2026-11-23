// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { generateDesktopIcons } from './icon.ts';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');

/** Bundle main process, sandboxed preload, and plugin-api runtime, plus build icons/license. */
export async function buildDesktop(): Promise<void> {
  const distDir = join(DESKTOP_DIR, 'dist');
  const runtimeDir = join(distDir, 'plugin-runtime');
  const buildResDir = join(DESKTOP_DIR, 'build');

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(buildResDir, { recursive: true });

  generateDesktopIcons(join(buildResDir, 'icon.png'), join(buildResDir, 'icon.ico'));
  copyFileSync(join(REPO_ROOT, 'LICENSE'), join(buildResDir, 'license.txt'));

  // 1. Main process bundle (ESM, Node target; externalizes electron and native @resvg/resvg-js)
  const mainBundle = await rolldown({
    input: join(DESKTOP_DIR, 'src', 'main.ts'),
    platform: 'node',
    external: ['electron', /^@resvg\/resvg-js(?:\/.*)?$/, /^node:/],
  });
  try {
    await mainBundle.write({
      file: join(distDir, 'main.mjs'),
      format: 'esm',
      codeSplitting: false,
      sourcemap: false,
    });
  } finally {
    await mainBundle.close();
  }

  // 2. Sandboxed preload bundle (CJS required when Electron sandbox: true)
  const preloadBundle = await rolldown({
    input: join(DESKTOP_DIR, 'src', 'preload.ts'),
    platform: 'node',
    external: ['electron', /^node:/],
  });
  try {
    await preloadBundle.write({
      file: join(distDir, 'preload.cjs'),
      format: 'cjs',
      codeSplitting: false,
      sourcemap: false,
    });
  } finally {
    await preloadBundle.close();
  }

  // 3. Standalone @cadllm/plugin-api bundle (bundles zod so child sandbox needs no node_modules)
  const pluginApiBundle = await rolldown({
    input: join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'index.ts'),
    platform: 'node',
    external: [/^node:/],
  });
  try {
    await pluginApiBundle.write({
      file: join(runtimeDir, 'plugin-api.mjs'),
      format: 'esm',
      codeSplitting: false,
      sourcemap: false,
    });
  } finally {
    await pluginApiBundle.close();
  }

  // 4. Network isolation guard preloaded into sandboxed plugin children
  copyFileSync(join(REPO_ROOT, 'packages', 'plugins', 'src', 'guard.mjs'), join(runtimeDir, 'guard.mjs'));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await buildDesktop();
  console.log('Built @cadllm/desktop bundles in packages/desktop/dist');
}
