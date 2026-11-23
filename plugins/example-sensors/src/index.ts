// SPDX-License-Identifier: MIT
import { connect, definePlugin, type PartDef, type PluginIssue } from '@cadllm/plugin-api';

const SERIES: Record<'E12' | 'E24', readonly number[]> = {
  E12: [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82],
  E24: [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91],
};

function parseOhms(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return undefined;
  switch (m[2]) {
    case 'k':
    case 'K':
      return num * 1e3;
    case 'M':
      return num * 1e6;
    case 'm':
      return num * 1e-3;
    case 'G':
    case 'g':
      return num * 1e9;
    default:
      return num;
  }
}

function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return `${Number((ohms / 1e6).toPrecision(3))}M`;
  if (ohms >= 1e3) return `${Number((ohms / 1e3).toPrecision(3))}k`;
  return `${Number(ohms.toPrecision(3))}`;
}

function generateCandidates(mantissas: readonly number[], minOhms: number, maxOhms: number): number[] {
  const values: number[] = [];
  for (let exp = 0; exp <= 6; exp++) {
    const scale = Math.pow(10, exp);
    for (const m of mantissas) {
      const r = m * scale;
      if (r >= minOhms && r <= maxOhms) values.push(r);
    }
  }
  return values;
}

function solveDivider(args: Record<string, unknown>): string {
  const vin = typeof args.vin === 'number' ? args.vin : Number(args.vin);
  const vout = typeof args.vout === 'number' ? args.vout : Number(args.vout);
  if (!Number.isFinite(vin) || vin <= 0) {
    throw new Error('vin must be a positive number');
  }
  if (!Number.isFinite(vout) || vout <= 0 || vout >= vin) {
    throw new Error('vout must satisfy 0 < vout < vin');
  }

  const seriesRaw = args.series === undefined ? 'E24' : String(args.series).trim().toUpperCase();
  if (seriesRaw !== 'E12' && seriesRaw !== 'E24') {
    throw new Error(`unsupported series "${String(args.series)}"; expected E12 or E24`);
  }
  const mantissas = SERIES[seriesRaw];

  const totalTarget = args.total !== undefined ? parseOhms(args.total) : undefined;
  if (args.total !== undefined && (totalTarget === undefined || totalTarget <= 0)) {
    throw new Error('total must be a positive resistance in ohms');
  }

  const minR = totalTarget !== undefined ? Math.max(10, totalTarget * 0.02) : 1000;
  const maxR = totalTarget !== undefined ? Math.min(1e7, totalTarget * 1.5) : 100000;
  const candidates = generateCandidates(mantissas, minR, maxR);
  if (candidates.length === 0) {
    throw new Error('no standard resistor values in requested range');
  }

  let best: { r1: number; r2: number; vActual: number; errPct: number; score: number } | undefined;
  for (const r1 of candidates) {
    for (const r2 of candidates) {
      const sum = r1 + r2;
      if (totalTarget !== undefined && (sum < totalTarget * 0.5 || sum > totalTarget * 1.5)) {
        continue;
      }
      const vActual = (vin * r2) / sum;
      const errPct = ((vActual - vout) / vout) * 100;
      const absRelVErr = Math.abs(vActual - vout) / vout;
      const totalPenalty = totalTarget !== undefined
        ? 0.05 * Math.abs(sum - totalTarget) / totalTarget
        : 1e-6 * Math.abs(Math.log10(sum) - Math.log10(20000));
      const score = absRelVErr + totalPenalty;
      if (!best || score < best.score) {
        best = { r1, r2, vActual, errPct, score };
      }
    }
  }

  if (!best) {
    throw new Error('no resistor divider pair found within constraints');
  }

  const sign = best.errPct > 0.005 ? '+' : '';
  return `R1=${formatOhms(best.r1)} R2=${formatOhms(best.r2)} Vout=${best.vActual.toFixed(3)}V err=${sign}${best.errPct.toFixed(2)}%`;
}

interface ParsedCircuit {
  components: Array<{ ref: string; part: string }>;
  pinNet: Map<string, string>;
  nets: Map<string, string[]>;
}

function parseCnlDetail1(cnl: string): ParsedCircuit {
  const components: Array<{ ref: string; part: string }> = [];
  const pinNet = new Map<string, string>();
  const nets = new Map<string, string[]>();

  const lines = cnl.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const colonMatch = line.match(/^([^:\s]+):\s*(.*)$/);
    if (colonMatch) {
      const netName = colonMatch[1]!;
      const pins = colonMatch[2]!.trim().split(/\s+/).filter(Boolean);
      nets.set(netName, pins);
      for (const p of pins) {
        pinNet.set(p.toUpperCase(), netName);
      }
    } else {
      const tokens = line.split(/\s+/);
      if (tokens.length >= 2) {
        components.push({ ref: tokens[0]!, part: tokens[1]! });
      }
    }
  }
  return { components, pinNet, nets };
}

function isGroundPinName(name: string): boolean {
  return /^(gnd\d*|vss|0v?)$/i.test(name);
}

function isGroundNetName(name: string): boolean {
  return /^(gnd|vss|0)$/i.test(name);
}

async function checkLedNoResistor(cadllm: Parameters<NonNullable<Parameters<typeof definePlugin>[0]['checks']>[string]>[0]): Promise<PluginIssue[]> {
  const cnl = await cadllm.project.read({ detail: 1 });
  const parsed = parseCnlDetail1(cnl);
  if (parsed.components.length === 0) return [];

  const partCache = new Map<string, PartDef | undefined>();
  const getPart = async (partId: string): Promise<PartDef | undefined> => {
    if (!partCache.has(partId)) {
      partCache.set(partId, await cadllm.parts.get(partId));
    }
    return partCache.get(partId);
  };

  const posNets = new Set<string>();
  const negNets = new Set<string>();
  const ledComps: Array<{ ref: string; part: string; partDef?: PartDef }> = [];

  for (const comp of parsed.components) {
    const partDef = await getPart(comp.part);
    const basePart = comp.part.includes(':') ? comp.part.split(':').pop()! : comp.part;
    const refUpper = comp.ref.toUpperCase();

    if (basePart === 'battery' || basePart === 'dc_supply') {
      const nPos = parsed.pinNet.get(`${refUpper}.+`) ?? parsed.pinNet.get(`${refUpper}.POS`) ?? parsed.pinNet.get(`${refUpper}.1`);
      const nNeg = parsed.pinNet.get(`${refUpper}.-`) ?? parsed.pinNet.get(`${refUpper}.NEG`) ?? parsed.pinNet.get(`${refUpper}.2`);
      if (nPos) posNets.add(nPos);
      if (nNeg) negNets.add(nNeg);
    } else if (basePart === 'vcc_symbol') {
      const nVcc = parsed.pinNet.get(`${refUpper}.VCC`) ?? parsed.pinNet.get(`${refUpper}.1`);
      if (nVcc) posNets.add(nVcc);
    } else if (basePart === 'gnd_symbol') {
      const nGnd = parsed.pinNet.get(`${refUpper}.GND`) ?? parsed.pinNet.get(`${refUpper}.1`);
      if (nGnd) negNets.add(nGnd);
    } else if (partDef) {
      for (const pin of partDef.pins) {
        const net = parsed.pinNet.get(`${refUpper}.${pin.name.toUpperCase()}`) ?? parsed.pinNet.get(`${refUpper}.${pin.id.toUpperCase()}`);
        if (!net) continue;
        if (pin.type === 'power_out') {
          if (isGroundPinName(pin.name) || isGroundPinName(pin.id)) negNets.add(net);
          else posNets.add(net);
        } else if (pin.type === 'power_in' && (isGroundPinName(pin.name) || isGroundPinName(pin.id))) {
          negNets.add(net);
        }
      }
    }

    if (basePart === 'led' || partDef?.sim?.some(s => s.kind === 'spice' && s.ref === 'LED')) {
      ledComps.push({ ref: comp.ref, part: comp.part, partDef });
    }
  }

  for (const netName of parsed.nets.keys()) {
    if (isGroundNetName(netName)) negNets.add(netName);
  }

  const issues: PluginIssue[] = [];
  for (const led of ledComps) {
    const refUpper = led.ref.toUpperCase();
    const anodeNet =
      parsed.pinNet.get(`${refUpper}.A`) ??
      parsed.pinNet.get(`${refUpper}.ANODE`) ??
      parsed.pinNet.get(`${refUpper}.+`) ??
      parsed.pinNet.get(`${refUpper}.1`);
    const cathodeNet =
      parsed.pinNet.get(`${refUpper}.K`) ??
      parsed.pinNet.get(`${refUpper}.CATHODE`) ??
      parsed.pinNet.get(`${refUpper}.-`) ??
      parsed.pinNet.get(`${refUpper}.2`);

    if (anodeNet && cathodeNet && anodeNet !== cathodeNet && posNets.has(anodeNet) && negNets.has(cathodeNet)) {
      issues.push({
        level: 'warn',
        code: 'led_no_resistor',
        message: `${led.ref} connects directly from ${anodeNet} to ${cathodeNet} with no series resistor`,
        at: [led.ref],
      });
    }
  }

  return issues;
}

definePlugin({
  tools: {
    calc_divider: args => solveDivider(args),
  },
  checks: {
    led_no_resistor: cadllm => checkLedNoResistor(cadllm),
  },
});

connect();
