// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { CadError } from '@cadllm/core';
import { parseIntelHex } from './hex.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_FQBN = 'arduino:avr:uno';
export const DEFAULT_ARDUINO_CLI_WIN = 'C:\\Program Files\\Arduino CLI\\arduino-cli.exe';
const MAX_ERROR_LINES = 6;

export interface CompileOptions {
  fqbn?: string;
}

export interface CompileResult {
  hex: string;
  size: number;
  cached: boolean;
  log: string;
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(envPath: string | undefined): string | null {
  if (!envPath) return null;
  const names = process.platform === 'win32'
    ? ['arduino-cli.exe', 'arduino-cli']
    : ['arduino-cli'];
  for (const dir of envPath.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve arduino-cli binary: CADLLM_ARDUINO_CLI -> PATH -> Windows default path. */
export function resolveArduinoCli(): string {
  const checked: string[] = [];
  const envCli = process.env.CADLLM_ARDUINO_CLI?.trim();
  if (envCli) {
    checked.push(`CADLLM_ARDUINO_CLI=${envCli}`);
    if (isRegularFile(envCli)) return envCli;
    throw missingCliError(checked);
  }

  checked.push('PATH (arduino-cli)');
  const onPath = findOnPath(process.env.PATH);
  if (onPath) return onPath;

  checked.push(DEFAULT_ARDUINO_CLI_WIN);
  if (isRegularFile(DEFAULT_ARDUINO_CLI_WIN)) return DEFAULT_ARDUINO_CLI_WIN;

  throw missingCliError(checked);
}

function missingCliError(checked: string[]): CadError {
  return new CadError(
    'invalid',
    `arduino-cli not found (checked: ${checked.join(', ')})`,
    'Install arduino-cli (e.g. `winget install ArduinoSA.CLI` or https://arduino.github.io/arduino-cli/) and run `arduino-cli core install arduino:avr`, or set CADLLM_ARDUINO_CLI.',
  );
}

function formatCompileErrors(rawLog: string, sketchPath: string): string {
  const normalized = rawLog
    .replaceAll(sketchPath, 'sketch.ino')
    .replace(/[A-Za-z]:\\[^\s:]*\\sketch\.ino|\/[^\s:]*\/sketch\.ino/g, 'sketch.ino');

  const lines = normalized.split(/\r?\n/).map((l) => l.trimEnd());
  const errorLines = lines.filter((l) =>
    /:\d+:(?:\d+:)?\s*(?:fatal\s+)?error:/i.test(l) || /^Error during build:/i.test(l),
  );
  const picked = (errorLines.length > 0 ? errorLines : lines.filter((l) => l.trim().length > 0))
    .slice(0, MAX_ERROR_LINES);

  return picked.length > 0 ? picked.join('\n') : 'unknown compilation error';
}

function stateBuildDir(): string {
  const stateDir = process.env.CADLLM_STATE_DIR?.trim() || join(homedir(), '.cadllm');
  return join(stateDir, 'build');
}

/** Compile an Arduino sketch to Intel HEX, caching builds by SHA-256(fqbn + '\0' + text). */
export async function compileSketch(text: string, opts: CompileOptions = {}): Promise<CompileResult> {
  if (typeof text !== 'string') {
    throw new CadError('invalid', 'sketch text must be a string');
  }
  const fqbn = opts.fqbn?.trim() || DEFAULT_FQBN;
  const hash = createHash('sha256').update(fqbn).update('\0').update(text).digest('hex');
  const buildDir = stateBuildDir();
  const cacheHexPath = join(buildDir, `${hash}.hex`);

  if (isRegularFile(cacheHexPath)) {
    const hex = await readFile(cacheHexPath, 'utf8');
    const { size } = parseIntelHex(hex);
    return { hex, size, cached: true, log: 'cached' };
  }

  const cli = resolveArduinoCli();
  const workDir = await mkdtemp(join(tmpdir(), 'cadllm-mcu-'));
  const sketchDir = join(workDir, 'sketch');
  const sketchPath = join(sketchDir, 'sketch.ino');
  const outDir = join(workDir, 'out');

  try {
    await mkdir(sketchDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(sketchPath, text, 'utf8');

    let log = '';
    try {
      const res = await execFileAsync(
        cli,
        ['compile', '--fqbn', fqbn, '--output-dir', outDir, sketchDir],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      log = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
      if (e.code === 'ENOENT') {
        throw missingCliError([cli]);
      }
      const combined = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
      throw new CadError('invalid', `compile error:\n${formatCompileErrors(combined, sketchPath)}`);
    }

    let hexPath = join(outDir, 'sketch.ino.hex');
    if (!isRegularFile(hexPath)) {
      const files = await readdir(outDir);
      const match = files.find((f) => f.endsWith('.ino.hex') && !f.endsWith('.with_bootloader.hex'));
      if (!match) {
        throw new CadError('invalid', 'arduino-cli succeeded but produced no .ino.hex output');
      }
      hexPath = join(outDir, match);
    }

    const hex = await readFile(hexPath, 'utf8');
    const { size } = parseIntelHex(hex);

    await mkdir(buildDir, { recursive: true });
    await writeFile(cacheHexPath, hex, 'utf8');

    return { hex, size, cached: false, log };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
