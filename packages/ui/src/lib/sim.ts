// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { parseSI, pinKey, type PartDef, type Query } from '@cadllm/core';
import type { RenderState } from '@cadllm/views';

export type NetStateVal = '0' | '1' | 'X' | 'Z' | number;

export interface TraceFrame {
  t: number;
  nets: Record<string, NetStateVal>;
}

export interface ParsedSimTrace {
  probes: string[];
  frames: TraceFrame[];
  duration: number;
  serial: Record<string, string>;
  truncatedRows: number;
  warnings: string[];
}

export interface PressInterval {
  ref: string;
  start: number;
  end: number;
}

const POWER_NET_RE = /^(VCC|VDD|AVDD|DVDD|5V|3V3|12V|VBUS|VBAT|\+5V|\+3V3)$/i;
const GROUND_NET_RE = /^(GND|AGND|DGND|PGND|VSS|0V)$/i;

/** Parse `read { code: ref }` text output into raw sketch source. */
export function parseReadCodeOutput(text: string, ref: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const firstNl = normalized.indexOf('\n');
  const firstLine = firstNl >= 0 ? normalized.slice(0, firstNl) : normalized;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}:\\s*no code\\s*$`, 'i').test(firstLine)) {
    return '';
  }
  if (new RegExp(`\\[code\\s+${escaped}\\]\\s*$`, 'i').test(firstLine)) {
    return firstNl >= 0 ? normalized.slice(firstNl + 1) : '';
  }
  return normalized;
}

function isAnalogProbe(probe: string): boolean {
  return /^[VI]\([^)]+\)$/i.test(probe.trim());
}

function parseCellValue(raw: string, analogProbe: boolean): NetStateVal {
  const trimmed = raw.trim();
  const up = trimmed.toUpperCase();
  if (!analogProbe && (up === '0' || up === '1' || up === 'X' || up === 'Z')) {
    return up;
  }
  const numVal = parseSI(trimmed);
  if (numVal !== undefined && Number.isFinite(numVal)) {
    return numVal;
  }
  if (up === '0' || up === '1' || up === 'X' || up === 'Z') {
    return up;
  }
  return 'X';
}

function parseHeaderLine(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  // Engine.sim prepends "<project> rev=<N> " before the table header "t  D13  ..."
  const stripped = trimmed.replace(/^\S+\s+rev=\d+\s+/, '');
  const cols = stripped.split(/\s+/).filter(Boolean);
  if (cols.length >= 2 && cols[0] === 't') {
    return cols.slice(1);
  }
  return undefined;
}

/** Parse aligned transition-table text returned by `sim` (`run` / `logic clock=... trace`). */
export function parseTransitionTable(text: string): ParsedSimTrace | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let headerIdx = -1;
  let probes: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const found = parseHeaderLine(lines[i]!);
    if (found) {
      headerIdx = i;
      probes = found;
      break;
    }
  }
  if (headerIdx < 0 || probes.length === 0) return null;

  const frames: TraceFrame[] = [];
  const serial: Record<string, string> = {};
  const warnings: string[] = [];
  let truncatedRows = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const moreMatch = trimmed.match(/^(?:\u2026|\.\.\.)\s*(\d+)\s+more(?:\s+rows?)?$/i);
    if (moreMatch) {
      truncatedRows = Number(moreMatch[1]);
      continue;
    }
    if (/^(?:PASS|FAIL)\b/.test(trimmed)) continue;
    const warnMatch = trimmed.match(/^warn:\s*(.+)$/i);
    if (warnMatch) {
      warnings.push(warnMatch[1]!);
      continue;
    }
    const serialMatch = trimmed.match(/^(?:serial\s+(\S+)|(\S+)\s+serial):\s*(.*)$/i);
    if (serialMatch) {
      const ref = (serialMatch[1] ?? serialMatch[2]!).trim();
      const body = serialMatch[3]!;
      serial[ref] = serial[ref] ? `${serial[ref]}\n${body}` : body;
      continue;
    }

    const toks = trimmed.split(/\s+/);
    if (toks.length < 2) continue;
    const t = parseSI(toks[0]!);
    if (t === undefined || !Number.isFinite(t) || t < 0) continue;

    const nets: Record<string, NetStateVal> = {};
    for (let c = 0; c < probes.length && c + 1 < toks.length; c++) {
      const probe = probes[c]!;
      nets[probe] = parseCellValue(toks[c + 1]!, isAnalogProbe(probe));
    }
    frames.push({ t, nets });
  }

  if (frames.length === 0) return null;
  frames.sort((a, b) => a.t - b.t);
  const duration = frames[frames.length - 1]!.t;
  return { probes, frames, duration, serial, truncatedRows, warnings };
}

/** Parse `press=SW1@0.5s-1.0s,SW2@1.5s-2s` into time intervals. */
export function parsePressIntervals(pressText: string): PressInterval[] {
  const out: PressInterval[] = [];
  for (const token of pressText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)) {
    const at = token.indexOf('@');
    if (at < 0) {
      out.push({ ref: token, start: 0, end: Infinity });
      continue;
    }
    const ref = token.slice(0, at).trim();
    const range = token.slice(at + 1).trim();
    if (!ref || !range) continue;
    const dash = range.indexOf('-');
    if (dash < 0) {
      const t = parseSI(range);
      if (t !== undefined) out.push({ ref, start: t, end: t + 0.25 });
      continue;
    }
    const start = parseSI(range.slice(0, dash));
    const end = parseSI(range.slice(dash + 1));
    if (start !== undefined && end !== undefined && end >= start) {
      out.push({ ref, start, end });
    }
  }
  return out;
}

/** Format the `sim` `run` command string from Run bar inputs. */
export function buildRunCommand(opts: { duration: string; press: string; probes: string }): string {
  const parts = ['run', opts.duration.trim() || '4s'];
  const press = opts.press.trim();
  if (press) parts.push(`press=${press.replace(/\s+/g, ',')}`);
  const probes = opts.probes.trim();
  if (probes) parts.push(`probes=${probes.replace(/\s+/g, ',')}`);
  return parts.join(' ');
}

export function isMcuPart(part: PartDef | undefined, partId: string): boolean {
  if (part?.sim?.some(s => s.kind === 'mcu')) return true;
  return partId.toLowerCase() === 'arduino_uno';
}

export function findMcuRefs(query: Query): string[] {
  return query
    .components()
    .filter(c => isMcuPart(query.parts.get(c.part), c.part))
    .map(c => c.ref);
}

export function findButtonRefs(query: Query): string[] {
  return query
    .components()
    .filter(c => {
      const part = query.parts.get(c.part);
      return c.part === 'button' || part?.views?.sch === 'button' || part?.views?.bb === 'button';
    })
    .map(c => c.ref);
}

/** Pick sensible default probes from MCU pins, buttons, and LEDs when user leaves probes blank. */
export function defaultProbesForQuery(query: Query): string[] {
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name.toUpperCase())) seen.add(name.toUpperCase());
  };
  const out: string[] = [];

  for (const comp of query.components()) {
    const part = query.parts.get(comp.part);
    const isMcu = isMcuPart(part, comp.part);
    const isLed = comp.part === 'led' || part?.views?.sch === 'led';
    const isBtn = comp.part === 'button' || part?.views?.sch === 'button';
    if (!isMcu && !isLed && !isBtn) continue;

    for (const pin of part?.pins ?? []) {
      const net = query.netOfPin(pinKey(comp.id, pin.id));
      if (!net) continue;
      if (POWER_NET_RE.test(net.name) || GROUND_NET_RE.test(net.name)) continue;
      if (!seen.has(net.name.toUpperCase())) {
        add(net.name);
        out.push(net.name);
      }
    }
  }

  if (out.length > 0) return out;
  return query.nets().map(n => n.name).filter(n => !POWER_NET_RE.test(n) && !GROUND_NET_RE.test(n));
}

function resolveProbeNetName(probe: string, query?: Query): string | undefined {
  const trimmed = probe.trim();
  const vMatch = trimmed.match(/^V\(([^)]+)\)$/i);
  const target = vMatch ? vMatch[1]!.trim() : trimmed;
  if (/^I\(/i.test(trimmed)) return undefined;

  if (query) {
    const byName = query.net(target);
    if (byName) return byName.name;
    if (target.includes('.')) {
      try {
        const resolved = query.resolvePin(target);
        return query.netOfPin(resolved.key)?.name;
      } catch {
        return undefined;
      }
    }
  }
  return target;
}

/** Sample net values at time `t` from a parsed transition trace. */
export function sampleTraceAt(
  trace: ParsedSimTrace,
  t: number,
  query?: Query,
): Record<string, NetStateVal> {
  if (trace.frames.length === 0) return {};
  let active = trace.frames[0]!;
  for (const f of trace.frames) {
    if (f.t <= t + 1e-9) active = f;
    else break;
  }

  const out: Record<string, NetStateVal> = {};
  for (const [probe, val] of Object.entries(active.nets)) {
    const netName = resolveProbeNetName(probe, query);
    if (netName) out[netName] = val;
  }
  return out;
}

function isHighVal(v: NetStateVal | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'number') return v >= 2.0;
  return v === '1';
}

function isLowVal(v: NetStateVal | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'number') return v <= 0.8;
  return v === '0';
}

/**
 * Build `RenderOptions.state` for time `t` from trace + press intervals + manual presses.
 * Propagates probed net levels across series resistors so LEDs connected via current-limiting
 * resistors glow even when only the MCU pin net (e.g. `D13`) is probed.
 */
export function deriveRenderState(
  query: Query,
  trace: ParsedSimTrace | null,
  t: number,
  pressIntervals: PressInterval[],
  manualPressed: Set<string>,
): RenderState | undefined {
  const sampled = trace ? sampleTraceAt(trace, t, query) : {};
  const hasPress = pressIntervals.length > 0 || manualPressed.size > 0;
  if (!trace && !hasPress) return undefined;

  const effective = new Map<string, NetStateVal>();
  const setEff = (name: string, val: NetStateVal) => effective.set(name.toUpperCase(), val);
  const getEff = (name: string): NetStateVal | undefined => effective.get(name.toUpperCase());

  for (const net of query.nets()) {
    if (GROUND_NET_RE.test(net.name)) setEff(net.name, '0');
    else if (POWER_NET_RE.test(net.name)) setEff(net.name, '1');
  }
  for (const [netName, val] of Object.entries(sampled)) {
    setEff(netName, val);
  }

  // Track which nets we want to visually color in `state.nets` (probed nets + derived LED nets).
  const visibleNets: Record<string, NetStateVal> = { ...sampled };

  // Propagate signal across 2-pin resistors to unprobed signal nets (e.g. D13 -> R1 -> LA -> D1.A).
  for (let pass = 0; pass < 2; pass++) {
    for (const comp of query.components()) {
      const part = query.parts.get(comp.part);
      if (comp.part !== 'res' && part?.views?.sch !== 'resistor') continue;
      const pins = part?.pins ?? [];
      if (pins.length < 2) continue;
      const n1 = query.netOfPin(pinKey(comp.id, pins[0]!.id));
      const n2 = query.netOfPin(pinKey(comp.id, pins[1]!.id));
      if (!n1 || !n2 || n1.id === n2.id) continue;
      const v1 = getEff(n1.name);
      const v2 = getEff(n2.name);
      const p1Rail = POWER_NET_RE.test(n1.name) || GROUND_NET_RE.test(n1.name);
      const p2Rail = POWER_NET_RE.test(n2.name) || GROUND_NET_RE.test(n2.name);

      if (v1 !== undefined && v2 === undefined && (!p1Rail || !p2Rail)) {
        setEff(n2.name, v1);
        if (!POWER_NET_RE.test(n2.name) && !GROUND_NET_RE.test(n2.name)) visibleNets[n2.name] = v1;
      } else if (v2 !== undefined && v1 === undefined && (!p1Rail || !p2Rail)) {
        setEff(n1.name, v2);
        if (!POWER_NET_RE.test(n1.name) && !GROUND_NET_RE.test(n1.name)) visibleNets[n1.name] = v2;
      }
    }
  }

  const parts: Record<string, { on?: boolean; level?: number }> = {};

  for (const comp of query.components()) {
    const part = query.parts.get(comp.part);
    if (comp.part === 'led' || part?.views?.sch === 'led') {
      const anode = part?.pins.find(p => p.name === 'A' || p.id === '1') ?? part?.pins[0];
      const cathode = part?.pins.find(p => p.name === 'K' || p.id === '2') ?? part?.pins[1];
      if (!anode || !cathode) continue;
      const nA = query.netOfPin(pinKey(comp.id, anode.id));
      const nK = query.netOfPin(pinKey(comp.id, cathode.id));
      const vA = nA ? getEff(nA.name) : undefined;
      const vK = nK ? getEff(nK.name) : undefined;

      if (typeof vA === 'number' && typeof vK === 'number') {
        const diff = vA - vK;
        if (diff > 1.2) {
          parts[comp.ref] = { on: true, level: Math.max(0.2, Math.min(1, (diff - 1.2) / 2.0)) };
        } else {
          parts[comp.ref] = { on: false, level: 0 };
        }
      } else if (isHighVal(vA) && isLowVal(vK)) {
        const level = typeof vA === 'number' ? Math.max(0.2, Math.min(1, vA / 5)) : 1;
        parts[comp.ref] = { on: true, level };
      } else {
        parts[comp.ref] = { on: false, level: 0 };
      }
      continue;
    }

    if (comp.part === 'button' || part?.views?.sch === 'button') {
      const up = comp.ref.toUpperCase();
      const intervalOn = pressIntervals.some(
        iv => iv.ref.toUpperCase() === up && t >= iv.start - 1e-9 && t <= iv.end + 1e-9,
      );
      const manualOn = manualPressed.has(up);
      if (intervalOn || manualOn) {
        parts[comp.ref] = { on: true };
      } else if (trace) {
        parts[comp.ref] = { on: false };
      }
    }
  }

  return { nets: visibleNets, parts };
}
