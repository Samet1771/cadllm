// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="12" y="12" width="232" height="232" rx="44" fill="#132238"/>
  <rect x="20" y="20" width="216" height="216" rx="36" fill="none" stroke="#2f5a96" stroke-width="4"/>
  <g stroke="#38bdf8" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M52 84 H92 L106 60 L122 108 L138 60 L154 108 L168 84 H204"/>
    <path d="M52 172 H96"/>
    <path d="M160 172 H204"/>
    <path d="M128 112 V172"/>
  </g>
  <polygon points="104,146 104,198 152,172" fill="#f59e0b" stroke="#fbbf24" stroke-width="4" stroke-linejoin="round"/>
  <line x1="156" y1="146" x2="156" y2="198" stroke="#fbbf24" stroke-width="8" stroke-linecap="round"/>
  <circle cx="52" cy="84" r="9" fill="#38bdf8"/>
  <circle cx="204" cy="84" r="9" fill="#38bdf8"/>
  <circle cx="52" cy="172" r="9" fill="#38bdf8"/>
  <circle cx="204" cy="172" r="9" fill="#38bdf8"/>
</svg>
`;

/** Pack PNG frames into a standard multi-size Windows .ico binary. */
function encodePngIco(frames: { size: number; png: Buffer }[]): Buffer {
  const headerSize = 6;
  const entrySize = 16;
  const tableSize = headerSize + frames.length * entrySize;
  let offset = tableSize;
  const totalBytes = tableSize + frames.reduce((acc, f) => acc + f.png.length, 0);
  const out = Buffer.alloc(totalBytes);

  out.writeUInt16LE(0, 0); // reserved
  out.writeUInt16LE(1, 2); // type = 1 (icon)
  out.writeUInt16LE(frames.length, 4);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const pos = headerSize + i * entrySize;
    const dim = f.size >= 256 ? 0 : f.size;
    out.writeUInt8(dim, pos);
    out.writeUInt8(dim, pos + 1);
    out.writeUInt8(0, pos + 2); // palette
    out.writeUInt8(0, pos + 3); // reserved
    out.writeUInt16LE(1, pos + 4); // planes
    out.writeUInt16LE(32, pos + 6); // bpp
    out.writeUInt32LE(f.png.length, pos + 8);
    out.writeUInt32LE(offset, pos + 12);
    f.png.copy(out, offset);
    offset += f.png.length;
  }
  return out;
}

/** Generate placeholder `icon.png` (256x256) and multi-size `icon.ico` using `@resvg/resvg-js`. */
export function generateDesktopIcons(pngPath: string, icoPath: string): void {
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => ({
    size,
    png: Buffer.from(
      new Resvg(ICON_SVG, { fitTo: { mode: 'width', value: size } }).render().asPng(),
    ),
  }));

  mkdirSync(dirname(pngPath), { recursive: true });
  mkdirSync(dirname(icoPath), { recursive: true });
  writeFileSync(pngPath, frames[frames.length - 1]!.png);
  writeFileSync(icoPath, encodePngIco(frames));
}
