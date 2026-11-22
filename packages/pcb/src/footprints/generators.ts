// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Footprint, PadDef, SilkShape } from '../types.ts';

const r2 = (n: number): number => Math.round(n * 1e4) / 1e4;

function computeCourtyard(
  pads: PadDef[],
  bodyBounds?: { minX: number; minY: number; maxX: number; maxY: number },
  margin = 0.25,
): { w: number; h: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } } {
  let minX = bodyBounds?.minX ?? Infinity;
  let minY = bodyBounds?.minY ?? Infinity;
  let maxX = bodyBounds?.maxX ?? -Infinity;
  let maxY = bodyBounds?.maxY ?? -Infinity;
  for (const p of pads) {
    minX = Math.min(minX, p.at[0] - p.size[0] / 2);
    maxX = Math.max(maxX, p.at[0] + p.size[0] / 2);
    minY = Math.min(minY, p.at[1] - p.size[1] / 2);
    maxY = Math.max(maxY, p.at[1] + p.size[1] / 2);
  }
  const bounds = {
    minX: r2(minX - margin),
    minY: r2(minY - margin),
    maxX: r2(maxX + margin),
    maxY: r2(maxY + margin),
  };
  return { w: r2(bounds.maxX - bounds.minX), h: r2(bounds.maxY - bounds.minY), bounds };
}

function makeFootprint(
  name: string,
  pads: PadDef[],
  silk: SilkShape[],
  bodyBounds?: { minX: number; minY: number; maxX: number; maxY: number },
  margin = 0.25,
): Footprint {
  const cy = computeCourtyard(pads, bodyBounds, margin);
  const symmetric = Math.abs(cy.bounds.minX + cy.bounds.maxX) < 1e-4 && Math.abs(cy.bounds.minY + cy.bounds.maxY) < 1e-4;
  return {
    name,
    pads,
    silk,
    courtyard: [cy.w, cy.h],
    origin: [0, 0],
    ...(symmetric ? {} : { courtyardBounds: cy.bounds }),
  };
}

/** Dual-inline through-hole package: 2.54 mm pin pitch, 7.62 mm row spacing. */
function genDip(name: string, count: number): Footprint {
  const half = count / 2;
  const pitch = 2.54;
  const rowX = 3.81; // 7.62 / 2
  const yStart = -((half - 1) * pitch) / 2;
  const pads: PadDef[] = [];

  for (let i = 0; i < half; i++) {
    pads.push({
      id: String(i + 1),
      shape: i === 0 ? 'rect' : 'oval',
      at: [-rowX, r2(yStart + i * pitch)],
      size: [1.6, 1.5],
      drill: 0.8,
      layers: 'TH',
    });
  }
  for (let k = 0; k < half; k++) {
    pads.push({
      id: String(half + 1 + k),
      shape: 'oval',
      at: [rowX, r2(yStart + (half - 1 - k) * pitch)],
      size: [1.6, 1.5],
      drill: 0.8,
      layers: 'TH',
    });
  }

  const bw = 5.4;
  const bh = r2(half * pitch);
  const silk: SilkShape[] = [
    { kind: 'line', from: [-bw / 2, -bh / 2], to: [-0.8, -bh / 2] },
    { kind: 'arc', at: [0, -bh / 2], r: 0.8, startDeg: 0, endDeg: 180 },
    { kind: 'line', from: [0.8, -bh / 2], to: [bw / 2, -bh / 2] },
    { kind: 'line', from: [bw / 2, -bh / 2], to: [bw / 2, bh / 2] },
    { kind: 'line', from: [bw / 2, bh / 2], to: [-bw / 2, bh / 2] },
    { kind: 'line', from: [-bw / 2, bh / 2], to: [-bw / 2, -bh / 2] },
    { kind: 'circle', at: [-bw / 2 + 0.7, r2(yStart)], r: 0.25 },
  ];
  return makeFootprint(name, pads, silk, { minX: -3.2, minY: -bh / 2, maxX: 3.2, maxY: bh / 2 });
}

/** Narrow SOIC SMD package (IPC-7351 nominal): 1.27 mm pitch, 5.40 mm pad row spacing. */
function genSoic(name: string, count: number): Footprint {
  const half = count / 2;
  const pitch = 1.27;
  const rowX = 2.7; // 5.40 / 2
  const yStart = -((half - 1) * pitch) / 2;
  const pads: PadDef[] = [];

  for (let i = 0; i < half; i++) {
    pads.push({
      id: String(i + 1),
      shape: 'roundrect',
      at: [-rowX, r2(yStart + i * pitch)],
      size: [1.55, 0.6],
      layers: 'F',
      roundRadius: 0.25,
    });
  }
  for (let k = 0; k < half; k++) {
    pads.push({
      id: String(half + 1 + k),
      shape: 'roundrect',
      at: [rowX, r2(yStart + (half - 1 - k) * pitch)],
      size: [1.55, 0.6],
      layers: 'F',
      roundRadius: 0.25,
    });
  }

  const bw = 3.5;
  const bh = r2(half * pitch + 0.3);
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [bw, bh] },
    { kind: 'circle', at: [-bw / 2 + 0.55, r2(yStart)], r: 0.22 },
  ];
  return makeFootprint(name, pads, silk, { minX: -1.95, minY: -bh / 2, maxX: 1.95, maxY: bh / 2 });
}

/** Single-row 2.54 mm pin header along Y. */
function genHeader1x(name: string, count: number): Footprint {
  const pitch = 2.54;
  const yStart = -((count - 1) * pitch) / 2;
  const pads: PadDef[] = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    shape: i === 0 ? 'rect' : 'circle',
    at: [0, r2(yStart + i * pitch)],
    size: [1.7, 1.7],
    drill: 1.0,
    layers: 'TH',
  }));
  const bh = r2(count * pitch);
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [2.54, bh] },
    { kind: 'circle', at: [-1.75, r2(yStart)], r: 0.18 },
  ];
  return makeFootprint(name, pads, silk, { minX: -2.0, minY: -bh / 2, maxX: 1.27, maxY: bh / 2 });
}

/** Radial polarized electrolytic capacitor parameterized by body diameter and pin pitch. */
function genRadialCap(name: string, diameter: number, pitch: number): Footprint {
  const padD = Math.min(1.8, Math.max(1.4, r2(pitch - 0.45)));
  const drill = padD >= 1.7 ? 0.9 : 0.75;
  const halfP = r2(pitch / 2);
  const r = r2(diameter / 2);
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-halfP, 0], size: [padD, padD], drill, layers: 'TH' },
    { id: '2', shape: 'circle', at: [halfP, 0], size: [padD, padD], drill, layers: 'TH' },
  ];
  const plusX = r2(-r * 0.65);
  const plusY = r2(-r * 0.55);
  const silk: SilkShape[] = [
    { kind: 'circle', at: [0, 0], r },
    { kind: 'line', from: [r2(plusX - 0.35), plusY], to: [r2(plusX + 0.35), plusY] },
    { kind: 'line', from: [plusX, r2(plusY - 0.35)], to: [plusX, r2(plusY + 0.35)] },
    { kind: 'arc', at: [0, 0], r: r2(r - 0.25), startDeg: -45, endDeg: 45 },
  ];
  return makeFootprint(name, pads, silk, { minX: -r, minY: -r, maxX: r, maxY: r });
}

/** THT round LED (2.54 mm pitch) with flat cathode edge on silkscreen. */
function genLedTht(name: string, diameter: number): Footprint {
  const r = r2(diameter / 2);
  const flangeR = r2(r + 0.4);
  const pads: PadDef[] = [
    { id: '1', shape: 'circle', at: [-1.27, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
    { id: '2', shape: 'rect', at: [1.27, 0], size: [1.6, 1.6], drill: 0.8, layers: 'TH' },
  ];
  const flatX = r2(flangeR * 0.82);
  const flatY = r2(Math.sqrt(Math.max(0, flangeR * flangeR - flatX * flatX)));
  const deg = r2((Math.atan2(flatY, flatX) * 180) / Math.PI);
  const silk: SilkShape[] = [
    { kind: 'circle', at: [0, 0], r },
    { kind: 'arc', at: [0, 0], r: flangeR, startDeg: deg, endDeg: 360 - deg },
    { kind: 'line', from: [flatX, -flatY], to: [flatX, flatY] },
  ];
  return makeFootprint(name, pads, silk, { minX: -flangeR, minY: -flangeR, maxX: flangeR, maxY: flangeR });
}

function genAxial(name: string, pitch: number, bodyLen: number, bodyDia: number, padD = 1.6, drill = 0.8, cathodeBar = false): Footprint {
  const halfP = r2(pitch / 2);
  const halfL = r2(bodyLen / 2);
  const halfW = r2(bodyDia / 2);
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-halfP, 0], size: [padD, padD], drill, layers: 'TH' },
    { id: '2', shape: 'circle', at: [halfP, 0], size: [padD, padD], drill, layers: 'TH' },
  ];
  const leadStart = r2(halfP - padD / 2 - 0.15);
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [bodyLen, bodyDia] },
  ];
  if (leadStart > halfL) {
    silk.push(
      { kind: 'line', from: [-leadStart, 0], to: [-halfL, 0] },
      { kind: 'line', from: [halfL, 0], to: [leadStart, 0] },
    );
  }
  if (cathodeBar) {
    silk.push({ kind: 'line', from: [r2(halfL * 0.62), -halfW], to: [r2(halfL * 0.62), halfW], width: 0.25 });
  }
  return makeFootprint(name, pads, silk, { minX: -halfL, minY: -halfW, maxX: halfL, maxY: halfW });
}

function gen0805(): Footprint {
  // IPC-7351 nominal 0805 (2012 metric): 1.90 mm pad center-to-center, 1.00 x 1.30 mm pads
  const pads: PadDef[] = [
    { id: '1', shape: 'roundrect', at: [-0.95, 0], size: [1.0, 1.3], layers: 'F', roundRadius: 0.2 },
    { id: '2', shape: 'roundrect', at: [0.95, 0], size: [1.0, 1.3], layers: 'F', roundRadius: 0.2 },
  ];
  const silk: SilkShape[] = [
    { kind: 'line', from: [-0.32, -0.85], to: [0.32, -0.85] },
    { kind: 'line', from: [-0.32, 0.85], to: [0.32, 0.85] },
  ];
  return makeFootprint('0805', pads, silk, { minX: -1.0, minY: -0.65, maxX: 1.0, maxY: 0.65 });
}

function genSod123(): Footprint {
  const pads: PadDef[] = [
    { id: '1', shape: 'roundrect', at: [-1.6, 0], size: [1.0, 1.2], layers: 'F', roundRadius: 0.2 },
    { id: '2', shape: 'roundrect', at: [1.6, 0], size: [1.0, 1.2], layers: 'F', roundRadius: 0.2 },
  ];
  const silk: SilkShape[] = [
    { kind: 'line', from: [-0.9, -0.95], to: [0.9, -0.95] },
    { kind: 'line', from: [-0.9, 0.95], to: [0.9, 0.95] },
    { kind: 'line', from: [0.75, -0.95], to: [0.75, 0.95], width: 0.25 },
  ];
  return makeFootprint('SOD-123', pads, silk, { minX: -1.35, minY: -0.8, maxX: 1.35, maxY: 0.8 });
}

function genTo92(): Footprint {
  // 1.27 mm inline pitch; oval pads keep >= 0.27 mm clearance between adjacent pads
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-1.27, 0], size: [1.0, 1.5], drill: 0.7, layers: 'TH' },
    { id: '2', shape: 'oval', at: [0, 0], size: [1.0, 1.5], drill: 0.7, layers: 'TH' },
    { id: '3', shape: 'oval', at: [1.27, 0], size: [1.0, 1.5], drill: 0.7, layers: 'TH' },
  ];
  // D-shaped body: flat side at y = +1.35, curved back radius 2.4 mm centered at (0, 0)
  const r = 2.4;
  const flatY = 1.35;
  const halfChord = r2(Math.sqrt(r * r - flatY * flatY));
  const deg = r2((Math.atan2(flatY, halfChord) * 180) / Math.PI);
  const silk: SilkShape[] = [
    { kind: 'line', from: [-halfChord, flatY], to: [halfChord, flatY] },
    { kind: 'arc', at: [0, 0], r, startDeg: deg, endDeg: 180 - deg },
  ];
  // Wait: in SVG/screen coords (+y down), angle 0 is +x, +90 is +y (bottom), -90 is -y (top).
  // Arc from (halfChord, +flatY) counter-clockwise over the top (-y) to (-halfChord, +flatY):
  // startDeg = 180 - deg (left bottom), endDeg = 360 + deg (over top 270° to right bottom).
  silk[1] = { kind: 'arc', at: [0, 0], r, startDeg: r2(180 - deg), endDeg: r2(360 + deg) };
  return makeFootprint('TO-92', pads, silk, { minX: -r, minY: -r, maxX: r, maxY: flatY });
}

function genSot23(): Footprint {
  // IPC-7351 nominal SOT-23: 1.90 mm pitch between pins 1 & 2, 2.10 mm row span
  const pads: PadDef[] = [
    { id: '1', shape: 'roundrect', at: [-1.05, -0.95], size: [1.0, 0.6], layers: 'F', roundRadius: 0.25 },
    { id: '2', shape: 'roundrect', at: [-1.05, 0.95], size: [1.0, 0.6], layers: 'F', roundRadius: 0.25 },
    { id: '3', shape: 'roundrect', at: [1.05, 0], size: [1.0, 0.6], layers: 'F', roundRadius: 0.25 },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [1.3, 2.9] },
    { kind: 'circle', at: [-0.4, -1.1], r: 0.18 },
  ];
  return makeFootprint('SOT-23', pads, silk, { minX: -0.65, minY: -1.45, maxX: 0.65, maxY: 1.45 });
}

function genPot9mm(): Footprint {
  // 9 mm vertical THT potentiometer (e.g. PTV09A / RK09K): 2.50 mm inline pitch
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-2.5, 2.5], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
    { id: '2', shape: 'circle', at: [0, 2.5], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
    { id: '3', shape: 'circle', at: [2.5, 2.5], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [9.5, 9.5] },
    { kind: 'circle', at: [0, -0.5], r: 3.0 },
  ];
  return makeFootprint('Potentiometer_THT_9mm', pads, silk, { minX: -4.75, minY: -4.75, maxX: 4.75, maxY: 4.75 });
}

function genSwPush6mm(): Footprint {
  // 6x6 mm tactile switch (6.5 mm span between pin pairs)
  const pads: PadDef[] = [
    { id: '1', shape: 'circle', at: [-3.25, 0], size: [1.8, 1.8], drill: 1.0, layers: 'TH' },
    { id: '2', shape: 'circle', at: [3.25, 0], size: [1.8, 1.8], drill: 1.0, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [6.0, 6.0] },
    { kind: 'circle', at: [0, 0], r: 1.75 },
  ];
  return makeFootprint('SW_PUSH_6mm', pads, silk, { minX: -3.0, minY: -3.0, maxX: 3.0, maxY: 3.0 });
}

function genSwSpstTht(): Footprint {
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-1.27, 0], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
    { id: '2', shape: 'circle', at: [1.27, 0], size: [1.7, 1.7], drill: 1.0, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [8.5, 4.5] },
    { kind: 'rect', at: [-0.8, 0], size: [2.2, 1.8] },
  ];
  return makeFootprint('SW_SPST_THT', pads, silk, { minX: -4.25, minY: -2.25, maxX: 4.25, maxY: 2.25 });
}

function genBuzzer12mm(): Footprint {
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-3.81, 0], size: [1.8, 1.8], drill: 0.9, layers: 'TH' },
    { id: '2', shape: 'circle', at: [3.81, 0], size: [1.8, 1.8], drill: 0.9, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'circle', at: [0, 0], r: 6.0 },
    { kind: 'circle', at: [0, 0], r: 1.2 },
    { kind: 'line', from: [-4.5, -2.5], to: [-3.5, -2.5] },
    { kind: 'line', from: [-4.0, -3.0], to: [-4.0, -2.0] },
  ];
  return makeFootprint('Buzzer_12mm', pads, silk, { minX: -6.0, minY: -6.0, maxX: 6.0, maxY: 6.0 });
}

function genBatteryHolder9V(): Footprint {
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-22.0, -6.35], size: [2.4, 2.4], drill: 1.2, layers: 'TH' },
    { id: '2', shape: 'circle', at: [-22.0, 6.35], size: [2.4, 2.4], drill: 1.2, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [54.0, 30.0] },
    { kind: 'line', from: [-19.5, -6.35], to: [-18.3, -6.35] },
    { kind: 'line', from: [-18.9, -6.95], to: [-18.9, -5.75] },
    { kind: 'line', from: [-19.5, 6.35], to: [-18.3, 6.35] },
  ];
  return makeFootprint('BatteryHolder_9V', pads, silk, { minX: -27.0, minY: -15.0, maxX: 27.0, maxY: 15.0 });
}

function genWireLeads(): Footprint {
  const pads: PadDef[] = [
    { id: '1', shape: 'rect', at: [-1.27, 0], size: [2.0, 2.0], drill: 1.0, layers: 'TH' },
    { id: '2', shape: 'circle', at: [1.27, 0], size: [2.0, 2.0], drill: 1.0, layers: 'TH' },
  ];
  const silk: SilkShape[] = [
    { kind: 'rect', at: [0, 0], size: [5.4, 3.0] },
    { kind: 'line', from: [-3.4, -0.5], to: [-2.8, -0.5] },
    { kind: 'line', from: [-3.1, -0.8], to: [-3.1, -0.2] },
  ];
  return makeFootprint('WireLeads', pads, silk, { minX: -3.5, minY: -1.5, maxX: 2.7, maxY: 1.5 });
}

/**
 * Arduino Uno R3 shield footprint centered at (0, 0).
 * Real Uno R3 outline: 68.58 x 53.34 mm (2.70" x 2.10"), top headers at y=2.54 mm,
 * bottom headers at y=50.80 mm, famous 4.064 mm (0.16") D7-D8 gap, 5.08 mm (0.20") VIN-A0 gap.
 */
function genArduinoUnoR3(): Footprint {
  const cx = 34.29; // 68.58 / 2
  const cy = 26.67; // 53.34 / 2
  const inToX = (inches: number) => r2(inches * 25.4 - cx);
  const topY = r2(2.54 - cy);   // -24.13
  const botY = r2(50.80 - cy);  // +24.13

  const pinDef = (id: string, xIn: number, y: number, first = false): PadDef => ({
    id,
    shape: first ? 'rect' : 'circle',
    at: [inToX(xIn), y],
    size: [1.7, 1.7],
    drill: 1.0,
    layers: 'TH',
  });

  const pads: PadDef[] = [];
  // Top-right header: D0..D7 (2.55" down to 1.85" in 0.1" steps)
  for (let d = 0; d <= 7; d++) {
    pads.push(pinDef(`D${d}`, 2.55 - d * 0.1, topY, d === 0));
  }
  // Top-left header: D8..D13, GND3, AREF (1.69" down to 0.99" in 0.1" steps — 0.16" gap D7->D8)
  for (let d = 8; d <= 13; d++) {
    pads.push(pinDef(`D${d}`, 1.69 - (d - 8) * 0.1, topY, d === 8));
  }
  pads.push(pinDef('GND3', 1.09, topY));
  pads.push(pinDef('AREF', 0.99, topY));

  // Bottom-right analog header: A5..A0 (2.55" down to 2.05" in 0.1" steps)
  for (let a = 5; a >= 0; a--) {
    pads.push(pinDef(`A${a}`, 2.55 - (5 - a) * 0.1, botY, a === 0));
  }
  // Bottom-left power header: VIN, GND2, GND1, 5V, 3V3, RESET, IOREF (1.85" down to 1.25")
  const pwrPins = ['VIN', 'GND2', 'GND1', '5V', '3V3', 'RESET', 'IOREF'];
  for (let i = 0; i < pwrPins.length; i++) {
    pads.push(pinDef(pwrPins[i]!, 1.85 - i * 0.1, botY, pwrPins[i] === 'IOREF'));
  }

  // Standard Uno R3 notched PCB outline
  const outlinePts: [number, number][] = [
    [r2(0 - cx), r2(0 - cy)],
    [r2(66.04 - cx), r2(0 - cy)],
    [r2(68.58 - cx), r2(2.54 - cy)],
    [r2(68.58 - cx), r2(40.64 - cy)],
    [r2(66.04 - cx), r2(43.18 - cy)],
    [r2(66.04 - cx), r2(53.34 - cy)],
    [r2(0 - cx), r2(53.34 - cy)],
  ];
  const silk: SilkShape[] = [
    { kind: 'poly', points: outlinePts, closed: true },
    // USB & Barrel jack outline markers on left edge
    { kind: 'rect', at: [r2(3.5 - cx), r2(15.2 - cy)], size: [12.0, 12.0] },
    { kind: 'rect', at: [r2(5.5 - cx), r2(44.5 - cy)], size: [14.0, 9.0] },
  ];
  return makeFootprint('Arduino_Uno_R3', pads, silk, { minX: -cx, minY: -cy, maxX: cx, maxY: cy }, 0.25);
}

const STATIC_FOOTPRINTS: Record<string, () => Footprint> = {
  '0805': gen0805,
  'THT-axial': () => genAxial('THT-axial', 10.16, 6.4, 2.5, 1.6, 0.8),
  'DO-35': () => genAxial('DO-35', 7.62, 3.8, 1.9, 1.6, 0.8, true),
  'DO-41': () => genAxial('DO-41', 10.16, 5.2, 2.7, 1.8, 1.0, true),
  'SOD-123': genSod123,
  'C_Disc_D5.0mm': () => genAxial('C_Disc_D5.0mm', 5.08, 5.0, 2.5, 1.6, 0.8),
  'L_Axial_L5.3mm': () => genAxial('L_Axial_L5.3mm', 7.62, 5.3, 2.2, 1.6, 0.8),
  'TO-92': genTo92,
  'SOT-23': genSot23,
  'Potentiometer_THT_9mm': genPot9mm,
  'SW_SPST_THT': genSwSpstTht,
  'SW_PUSH_6mm': genSwPush6mm,
  'Buzzer_12mm': genBuzzer12mm,
  'BatteryHolder_9V': genBatteryHolder9V,
  'WireLeads': genWireLeads,
  'Arduino_Uno_R3': genArduinoUnoR3,
};

export const KNOWN_FOOTPRINT_NAMES: readonly string[] = [
  '0805',
  'Arduino_Uno_R3',
  'BatteryHolder_9V',
  'Buzzer_12mm',
  'CP_Radial_D5.0mm_P2.00mm',
  'CP_Radial_D8.0mm_P3.50mm',
  'C_Disc_D5.0mm',
  'DIP-8',
  'DIP-14',
  'DIP-16',
  'DO-35',
  'DO-41',
  'Header_1x02_P2.54mm',
  'Header_1x03_P2.54mm',
  'LED_D3.0mm',
  'LED_D5.0mm',
  'L_Axial_L5.3mm',
  'Potentiometer_THT_9mm',
  'SOD-123',
  'SOIC-8',
  'SOIC-14',
  'SOIC-16',
  'SOT-23',
  'SW_PUSH_6mm',
  'SW_SPST_THT',
  'THT-axial',
  'TO-92',
  'WireLeads',
];

export function generateFootprint(name: string): Footprint {
  const staticFn = STATIC_FOOTPRINTS[name];
  if (staticFn) return staticFn();

  const dipMatch = name.match(/^DIP-(\d+)$/);
  if (dipMatch) {
    const n = Number(dipMatch[1]);
    if (n >= 4 && n % 2 === 0) return genDip(name, n);
  }

  const soicMatch = name.match(/^SOIC-(\d+)$/);
  if (soicMatch) {
    const n = Number(soicMatch[1]);
    if (n >= 4 && n % 2 === 0) return genSoic(name, n);
  }

  const hdrMatch = name.match(/^Header_1x(\d+)_P2\.54mm$/);
  if (hdrMatch) {
    const n = Number(hdrMatch[1]);
    if (n >= 1) return genHeader1x(name, n);
  }

  const radMatch = name.match(/^CP_Radial_D(\d+(?:\.\d+)?)mm_P(\d+(?:\.\d+)?)mm$/);
  if (radMatch) {
    const d = Number(radMatch[1]);
    const p = Number(radMatch[2]);
    if (d > 0 && p > 0) return genRadialCap(name, d, p);
  }

  const ledMatch = name.match(/^LED_D(\d+(?:\.\d+)?)mm$/);
  if (ledMatch) {
    const d = Number(ledMatch[1]);
    if (d > 0) return genLedTht(name, d);
  }

  throw new Error(`unknown PCB footprint "${name}"`);
}
