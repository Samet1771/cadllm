#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { plot, read, renderBoard, renderLayers, stringifySvg } from '@tracespace/core';
import { loadCircuit } from '@cadllm/dsl';
import { builtinPartsDir, loadLibrary } from '@cadllm/library';
import { autoPlacePcb, isPcbPart, ratsnest, route } from '@cadllm/pcb';
import { bom, excellon, fabZip, gerbers, pickAndPlace, projectName } from '../src/index.ts';

const LAYER_COLORS: Record<string, string> = {
  copper: '#f59e0b',
  soldermask: '#10b981',
  silkscreen: '#f8fafc',
  outline: '#38bdf8',
  drill: '#e2e8f0',
};

function colorizeLayerSvg(svg: string, type: string | null): string {
  const color = (type && LAYER_COLORS[type]) ?? '#f8fafc';
  return svg.replace('<svg ', `<svg style="color:${color}" `);
}

function buildCombinedBoardSvg(topSvg: string, bottomSvg: string, viewBox: [number, number, number, number]): string {
  const [, , vw, vh] = viewBox;
  const w = vw > 0 ? vw : 30;
  const h = vh > 0 ? vh : 20;
  const gap = Math.max(w * 0.12, 3);
  const pad = Math.max(w * 0.08, 2);
  const labelH = Math.max(h * 0.14, 2.5);
  const totalW = w * 2 + gap + pad * 2;
  const totalH = h + pad * 2 + labelH;
  const fontSize = Math.max(Math.min(w, h) * 0.08, 1.4);

  const b64Top = Buffer.from(topSvg, 'utf8').toString('base64');
  const b64Bot = Buffer.from(bottomSvg, 'utf8').toString('base64');

  const topX = pad;
  const botX = pad + w + gap;
  const boardY = pad + labelH;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}mm" height="${totalH}mm">`,
    `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#0f172a"/>`,
    `<text x="${topX + w / 2}" y="${pad + labelH * 0.65}" fill="#e2e8f0" font-family="sans-serif" font-size="${fontSize}" text-anchor="middle">TOP (${w}x${h} mm)</text>`,
    `<text x="${botX + w / 2}" y="${pad + labelH * 0.65}" fill="#e2e8f0" font-family="sans-serif" font-size="${fontSize}" text-anchor="middle">BOTTOM (${w}x${h} mm)</text>`,
    `<image x="${topX}" y="${boardY}" width="${w}" height="${h}" href="data:image/svg+xml;base64,${b64Top}"/>`,
    `<image x="${botX}" y="${boardY}" width="${w}" height="${h}" href="data:image/svg+xml;base64,${b64Bot}"/>`,
    `</svg>`,
  ].join('\n');
}

export interface FabPreviewResult {
  project: string;
  zipPath: string;
  layerFiles: string[];
  layerSvgs: string[];
  layerPngs: string[];
  topPngPath: string;
  bottomPngPath: string;
  combinedPngPath: string;
}

export interface FabPreviewOptions {
  layerWidth?: number;
  boardWidth?: number;
}

export async function generateFabPreview(cnlFile: string, outDir: string, opts: FabPreviewOptions = {}): Promise<FabPreviewResult> {
  const layerWidth = opts.layerWidth ?? 800;
  const boardWidth = opts.boardWidth ?? 1000;
  const lib = loadLibrary([builtinPartsDir]);
  const fullCnl = resolve(cnlFile);
  const fullOut = resolve(outDir);
  const doc = loadCircuit(readFileSync(fullCnl, 'utf8'), lib);

  // Auto-place PCB components if any PCB component lacks a PCB placement
  const needsPlace = doc.read.components().some(c => {
    const part = doc.read.parts.get(c.part);
    return part !== undefined && isPcbPart(part) && !c.place.pcb;
  });
  if (needsPlace) {
    try {
      const placed = autoPlacePcb(doc.read);
      const entries = Object.entries(placed.place);
      if (entries.length > 0) {
        doc.transact(tx => {
          for (const [ref, pl] of entries) tx.updateComponent(ref, { place: { pcb: pl } });
        }, { label: 'layout pcb' });
      }
    } catch (err) {
      if (!(err instanceof Error && /not implemented yet/i.test(err.message))) throw err;
    }
  }

  // Autoroute PCB connections if unrouted
  let needsRoute = (doc.read.circuit.pcb?.tracks.length ?? 0) === 0;
  if (!needsRoute) {
    try {
      needsRoute = ratsnest(doc.read).count > 0;
    } catch {
      // ignore if ratsnest not available
    }
  }
  if (needsRoute) {
    try {
      const routed = route(doc.read);
      if (routed.tracks.length > 0 || routed.vias.length > 0) {
        doc.transact(tx => {
          const pcb = tx.ensurePcb();
          pcb.tracks.push(...routed.tracks);
          pcb.vias.push(...routed.vias);
        }, { label: 'route pcb' });
      }
    } catch (err) {
      if (!(err instanceof Error && /not implemented yet/i.test(err.message))) throw err;
    }
  }

  mkdirSync(fullOut, { recursive: true });
  const proj = projectName(doc.read);

  // Write zip
  const zipPath = join(fullOut, `${proj}-fab.zip`);
  writeFileSync(zipPath, fabZip(doc.read));

  // Write individual Gerbers, Drill files, BOM, PnP
  const gbrMap = gerbers(doc.read);
  const drlMap = excellon(doc.read);
  const layerFiles: string[] = [];

  for (const [name, content] of Object.entries({ ...gbrMap, ...drlMap }).sort(([a], [b]) => a.localeCompare(b))) {
    const p = join(fullOut, name);
    writeFileSync(p, content, 'utf8');
    layerFiles.push(p);
  }
  writeFileSync(join(fullOut, `${proj}-bom.csv`), bom(doc.read), 'utf8');
  writeFileSync(join(fullOut, `${proj}-pnp.csv`), pickAndPlace(doc.read), 'utf8');

  // Parse, plot, and render with @tracespace/core
  const readRes = await read(layerFiles);
  const plotted = plot(readRes);
  const rendered = renderLayers(plotted);
  const board = renderBoard(rendered);

  const layerSvgs: string[] = [];
  const layerPngs: string[] = [];
  for (const layer of rendered.layers) {
    const rawSvg = stringifySvg(rendered.rendersById[layer.id]!);
    const coloredSvg = colorizeLayerSvg(rawSvg, layer.type);
    const svgPath = join(fullOut, `${layer.filename}.svg`);
    const pngPath = join(fullOut, `${layer.filename}.png`);
    writeFileSync(svgPath, coloredSvg, 'utf8');
    const png = new Resvg(coloredSvg, { fitTo: { mode: 'width', value: layerWidth }, background: '#111827' }).render().asPng();
    writeFileSync(pngPath, png);
    layerSvgs.push(svgPath);
    layerPngs.push(pngPath);
  }

  const topSvg = stringifySvg(board.top);
  const bottomSvg = stringifySvg(board.bottom);
  const topSvgPath = join(fullOut, `${proj}-top.svg`);
  const bottomSvgPath = join(fullOut, `${proj}-bottom.svg`);
  const topPngPath = join(fullOut, `${proj}-top.png`);
  const bottomPngPath = join(fullOut, `${proj}-bottom.png`);
  writeFileSync(topSvgPath, topSvg, 'utf8');
  writeFileSync(bottomSvgPath, bottomSvg, 'utf8');

  const topPng = new Resvg(topSvg, { fitTo: { mode: 'width', value: boardWidth }, background: '#0f172a' }).render().asPng();
  const bottomPng = new Resvg(bottomSvg, { fitTo: { mode: 'width', value: boardWidth }, background: '#0f172a' }).render().asPng();
  writeFileSync(topPngPath, topPng);
  writeFileSync(bottomPngPath, bottomPng);

  const combinedSvg = buildCombinedBoardSvg(topSvg, bottomSvg, rendered.boardShapeRender.viewBox);
  const combinedSvgPath = join(fullOut, `${proj}-preview.svg`);
  const combinedPngPath = join(fullOut, `${proj}-preview.png`);
  writeFileSync(combinedSvgPath, combinedSvg, 'utf8');
  const combinedPng = new Resvg(combinedSvg, { fitTo: { mode: 'width', value: boardWidth * 2 }, background: '#0f172a' }).render().asPng();
  writeFileSync(combinedPngPath, combinedPng);

  return {
    project: proj,
    zipPath,
    layerFiles,
    layerSvgs,
    layerPngs,
    topPngPath,
    bottomPngPath,
    combinedPngPath,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [cnlArg, outArg] = process.argv.slice(2);
  if (!cnlArg || !outArg) {
    console.error('usage: node packages/export/scripts/fab-preview.ts <file.cnl> <outdir>');
    process.exitCode = 2;
  } else {
    generateFabPreview(cnlArg, outArg).then(
      res => {
        console.log(`ok preview ${res.project} -> ${res.zipPath} · ${res.layerPngs.length} layer PNGs · ${res.combinedPngPath}`);
      },
      err => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      },
    );
  }
}
