// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { basicChecks, Doc, naturalCompare, parseSI, type PartDef, type PcbLayer, type PcbRules, type TxInfo } from '@cadllm/core';
import { VIEWS, type ViewId } from '@cadllm/views';
import { buildPartResolver } from './parts.ts';
import { autoPlacePcbWithFallback, checkPcbDrc, routePcbWithFallback } from './pcbFallback.ts';
import { parsePressIntervals } from './sim.ts';
import type {
  ChangedNotification,
  PluginPanelPayload,
  PluginStatusItem,
  RegistryPluginItem,
  RpcApi,
  StateResponse,
} from './types.ts';

const DEMO_SENSOR_PANEL_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: system-ui, sans-serif; margin: 12px; font-size: 12px; color: #1b1f24; background: #fafbfc; }
    h3 { margin: 0 0 8px; font-size: 13px; }
    .row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
    input { width: 72px; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 4px; }
    button { padding: 5px 10px; border: 1px solid #2563eb; background: #2563eb; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
    button.sec { background: #fff; color: #1b1f24; border-color: #cbd5e1; }
    pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px; white-space: pre-wrap; font-size: 11px; max-height: 160px; overflow: auto; }
  </style>
</head>
<body>
  <h3>Sensor Divider Calculator</h3>
  <div class="row">
    <label>Vin (V) <input id="vin" type="number" value="5" step="0.1" /></label>
    <label>Vout (V) <input id="vout" type="number" value="3.3" step="0.1" /></label>
  </div>
  <div class="row">
    <button id="btn-read" class="sec" type="button">Read Circuit</button>
    <button id="btn-edit" type="button">Propose Divider Edit</button>
  </div>
  <pre id="out">Click "Read Circuit" or "Propose Divider Edit".</pre>
  <script>
    const out = document.getElementById('out');
    document.getElementById('btn-read').addEventListener('click', async () => {
      try {
        const text = await window.cadllm.read({ detail: 1 });
        out.textContent = text;
      } catch (err) {
        out.textContent = 'Error: ' + err.message;
      }
    });
    document.getElementById('btn-edit').addEventListener('click', async () => {
      const vin = Number(document.getElementById('vin').value) || 5;
      const vout = Number(document.getElementById('vout').value) || 3.3;
      const r1 = '5.1k';
      const r2 = vout >= vin ? '10k' : Math.round((10 * vout) / Math.max(0.1, vin - vout) * 10) / 10 + 'k';
      const cnl = 'R10 res ' + r1 + '; R11 res ' + r2 + '; DIV_IN: R10.1; DIV_OUT: R10.2 R11.1; GND: R11.2';
      try {
        const res = await window.cadllm.requestEdit(cnl);
        out.textContent = 'Applied: ' + res;
      } catch (err) {
        out.textContent = 'Edit not applied: ' + err.message;
      }
    });
  </script>
</body>
</html>`;

const DEMO_SENSOR_MANIFEST: PluginStatusItem = {
  id: 'org.example.sensors',
  name: 'Example Sensor Pack',
  version: '1.0.0',
  summary: 'LDR photoresistor, NTC 10k thermistor, voltage divider solver, and Sensor Calculator panel',
  publisher: 'example',
  license: 'MIT',
  state: 'loaded',
  requestedPermissions: ['project:read', 'project:write'],
  grantedPermissions: ['project:read', 'project:write'],
  contributions: ['models', 'panels', 'parts', 'tools'],
  contributes: {
    parts: 'parts',
    models: [{ id: 'LDR', kind: 'spice', file: 'models/ldr.cir' }],
    tools: [{ name: 'calc_divider', summary: 'solve resistor divider for Vin/Vout (E12/E24)' }],
    panels: [{ id: 'sensors', title: 'Sensor Calculator', main: 'panel/index.html' }],
  },
};

const DEMO_REGISTRY_INDEX: RegistryPluginItem[] = [
  {
    id: 'org.example.sensors',
    name: 'Example Sensor Pack',
    summary: 'LDR photoresistor, NTC 10k thermistor, voltage divider solver, and Sensor Calculator panel',
    publisher: 'example',
    license: 'MIT',
    versions: [
      {
        version: '1.0.0',
        engine: '^1.0.0',
        url: 'packages/org.example.sensors-1.0.0.cnlplugin',
        sha256: 'demo-sha256',
        size: 4096,
        permissions: ['project:read', 'project:write'],
        contributes: ['models', 'panels', 'parts', 'tools'],
        signature: 'demo-sig',
      },
    ],
  },
  {
    id: 'org.example.telemetry',
    name: 'Telemetry Probes',
    summary: 'Inspect circuit power rails and forward summary metrics to a remote endpoint',
    publisher: 'example',
    license: 'MIT',
    versions: [
      {
        version: '0.4.0',
        engine: '^1.0.0',
        url: 'packages/org.example.telemetry-0.4.0.cnlplugin',
        sha256: 'demo-sha256-2',
        size: 2048,
        permissions: ['project:read', 'net:api.example.com'],
        contributes: ['tools', 'checks'],
        signature: 'demo-sig-2',
      },
    ],
  },
];

export const DEMO_PARTS: PartDef[] = [
  {
    id: 'arduino_uno',
    name: 'Arduino Uno',
    summary: 'ATmega328P microcontroller board (header pins)',
    category: 'board',
    refPrefix: 'U',
    pins: [
      { id: 'D0', name: 'D0', aliases: ['RX'], type: 'bidir' },
      { id: 'D1', name: 'D1', aliases: ['TX'], type: 'bidir' },
      { id: 'D2', name: 'D2', type: 'bidir' },
      { id: 'D3', name: 'D3', type: 'bidir' },
      { id: 'D4', name: 'D4', type: 'bidir' },
      { id: 'D5', name: 'D5', type: 'bidir' },
      { id: 'D6', name: 'D6', type: 'bidir' },
      { id: 'D7', name: 'D7', type: 'bidir' },
      { id: 'D8', name: 'D8', type: 'bidir' },
      { id: 'D9', name: 'D9', type: 'bidir' },
      { id: 'D10', name: 'D10', type: 'bidir' },
      { id: 'D11', name: 'D11', type: 'bidir' },
      { id: 'D12', name: 'D12', type: 'bidir' },
      { id: 'D13', name: 'D13', type: 'bidir' },
      { id: 'A0', name: 'A0', type: 'bidir' },
      { id: 'A1', name: 'A1', type: 'bidir' },
      { id: 'A2', name: 'A2', type: 'bidir' },
      { id: 'A3', name: 'A3', type: 'bidir' },
      { id: 'A4', name: 'A4', type: 'bidir' },
      { id: 'A5', name: 'A5', type: 'bidir' },
      { id: '5V', name: '5V', type: 'power_out' },
      { id: '3V3', name: '3V3', type: 'power_out' },
      { id: 'VIN', name: 'VIN', type: 'power_in' },
      { id: 'GND1', name: 'GND', type: 'power_in' },
      { id: 'GND2', name: 'GND2', type: 'power_in' },
      { id: 'GND3', name: 'GND3', type: 'power_in' },
      { id: 'RESET', name: 'RESET', type: 'input' },
      { id: 'AREF', name: 'AREF', type: 'passive' },
      { id: 'IOREF', name: 'IOREF', type: 'power_out' },
    ],
    sim: [{ kind: 'mcu', ref: 'avr8js-uno' }],
    footprints: ['Arduino_Uno_R3'],
    views: { sch: 'board', bb: 'arduino_uno' },
  },
  {
    id: 'battery',
    name: 'Battery',
    summary: 'DC battery power source',
    category: 'source',
    refPrefix: 'BAT',
    pins: [
      { id: '1', name: '+', aliases: ['pos'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '9', description: 'Battery voltage' } },
    valueProp: 'voltage',
    sim: [{ kind: 'spice', ref: 'V' }, { kind: 'logic', ref: 'const' }],
    views: { sch: 'battery', bb: 'battery' },
  },
  {
    id: 'res',
    name: 'Resistor',
    summary: 'axial/SMD resistor',
    category: 'passive',
    refPrefix: 'R',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: { resistance: { type: 'number', unit: 'Ω', default: '1k', description: 'Resistance' } },
    valueProp: 'resistance',
    sim: [{ kind: 'spice', ref: 'R' }, { kind: 'logic', ref: 'pull' }],
    footprints: ['0805', 'THT-axial'],
    views: { sch: 'resistor', bb: 'axial' },
  },
  {
    id: 'led',
    name: 'LED',
    summary: 'light-emitting diode',
    category: 'io',
    refPrefix: 'D',
    pins: [
      { id: '1', name: 'A', aliases: ['anode', '+'], type: 'passive' },
      { id: '2', name: 'K', aliases: ['cathode', '-'], type: 'passive' },
    ],
    props: { color: { type: 'enum', options: ['red', 'green', 'blue', 'yellow', 'white'], default: 'red' } },
    valueProp: 'color',
    sim: [{ kind: 'spice', ref: 'LED' }],
    footprints: ['LED_D5.0mm', 'LED_D3.0mm'],
    views: { sch: 'led', bb: 'led' },
  },
  {
    id: 'button',
    name: 'Push Button',
    summary: 'momentary tactile push button',
    category: 'io',
    refPrefix: 'SW',
    pins: [
      { id: '1', name: '1', type: 'passive' },
      { id: '2', name: '2', type: 'passive' },
    ],
    props: { state: { type: 'enum', options: ['released', 'pressed'], default: 'released' } },
    valueProp: 'state',
    sim: [{ kind: 'spice', ref: 'SW' }, { kind: 'logic', ref: 'switch' }],
    footprints: ['SW_PUSH_6mm'],
    views: { sch: 'button', bb: 'button' },
  },
  {
    id: '74hc00',
    name: '74HC00 Quad NAND',
    summary: 'quad 2-input NAND gate',
    category: 'logic',
    refPrefix: 'U',
    pins: [
      { id: '1', name: '1A', type: 'input' },
      { id: '2', name: '1B', type: 'input' },
      { id: '3', name: '1Y', type: 'output' },
      { id: '4', name: '2A', type: 'input' },
      { id: '5', name: '2B', type: 'input' },
      { id: '6', name: '2Y', type: 'output' },
      { id: '7', name: 'GND', type: 'power_in' },
      { id: '8', name: '3Y', type: 'output' },
      { id: '9', name: '3A', type: 'input' },
      { id: '10', name: '3B', type: 'input' },
      { id: '11', name: '4Y', type: 'output' },
      { id: '12', name: '4A', type: 'input' },
      { id: '13', name: '4B', type: 'input' },
      { id: '14', name: 'VCC', type: 'power_in' },
    ],
    sim: [{ kind: 'logic', ref: '74hc00' }],
    footprints: ['DIP-14', 'SOIC-14'],
    views: { sch: 'ic', bb: 'dip' },
  },
  {
    id: 'dc_supply',
    name: 'DC Supply Header',
    summary: '2-pin DC power header',
    category: 'source',
    refPrefix: 'J',
    pins: [
      { id: '1', name: '+', aliases: ['pos', 'VCC'], type: 'power_out' },
      { id: '2', name: '-', aliases: ['neg', 'GND'], type: 'power_out' },
    ],
    props: { voltage: { type: 'number', unit: 'V', default: '5', description: 'Supply voltage' } },
    valueProp: 'voltage',
    footprints: ['Header_1x02_P2.54mm'],
    views: { sch: 'battery', bb: 'battery' },
  },
];

const BLINK_CODE = [
  'void setup() {',
  '  pinMode(13, OUTPUT);',
  '  Serial.begin(9600);',
  '  Serial.println("blink ready");',
  '}',
  '',
  'void loop() {',
  '  digitalWrite(13, HIGH);',
  '  delay(1000);',
  '  digitalWrite(13, LOW);',
  '  delay(1000);',
  '}',
].join('\n');

const BUTTON_LED_CODE = [
  'void setup() {',
  '  pinMode(2, INPUT);',
  '  pinMode(13, OUTPUT);',
  '}',
  '',
  'void loop() {',
  '  digitalWrite(13, digitalRead(2));',
  '}',
].join('\n');

export interface DemoBackend extends RpcApi {
  onChanged(cb: (n: ChangedNotification) => void): () => void;
  simulateAiEdit(): void;
}

function fmtDemoTime(t: number): string {
  if (Math.abs(t) < 1e-9) return '0';
  if (t >= 1) return `${Number(t.toFixed(3))}s`;
  return `${Number((t * 1000).toFixed(2))}m`;
}

function runCannedDemoSim(doc: Doc, projectName: string, runCmd: string): string {
  const m = runCmd.trim().match(/^run\s+(\S+)(.*)$/i);
  if (!m) {
    return `${projectName} rev=${doc.rev} ok (demo mode: try "run 4s probes=D13" or connect cadllm serve)`;
  }
  const dur = Math.max(0.2, Math.min(20, parseSI(m[1]!) ?? 4));
  const rest = m[2] ?? '';
  const pressMatch = rest.match(/press=([^\s]+)/i);
  const probesMatch = rest.match(/probes=([^\s]+)/i);
  const pressIntervals = pressMatch ? parsePressIntervals(pressMatch[1]!) : [];
  const requestedProbes = probesMatch
    ? probesMatch[1]!.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const q = doc.read;
  const hasButton = q.components().some(c => c.part === 'button');
  const mcu = q.components().find(c => c.part === 'arduino_uno');
  const code = mcu ? q.circuit.meta[`__code:${mcu.ref}`] ?? '' : '';

  if (hasButton && (pressIntervals.length > 0 || requestedProbes.some(p => p.toUpperCase() === 'D2'))) {
    const probes = requestedProbes.length > 0 ? requestedProbes : ['D2', 'D13'];
    const times = new Set<number>([0, dur]);
    for (const iv of pressIntervals) {
      if (iv.start >= 0 && iv.start <= dur) times.add(iv.start);
      if (iv.end >= 0 && iv.end <= dur) times.add(iv.end);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const lines = [`${projectName} rev=${doc.rev} t     ${probes.join(' ')}`];
    for (const t of sorted) {
      const pressed = pressIntervals.some(iv => t >= iv.start - 1e-9 && t < iv.end - 1e-9);
      const val = pressed ? '1' : '0';
      lines.push(`${fmtDemoTime(t).padEnd(5)} ${probes.map(p => (p.startsWith('V(') ? (pressed ? '5' : '0') : val).padEnd(p.length)).join(' ').trimEnd()}`);
    }
    return lines.join('\n');
  }

  // Canned Blink trace: uses delay(...) from sketch if present, defaulting to 1s.
  const delayMatch = code.match(/delay\((\d+)\)/);
  const halfPeriod = delayMatch ? Math.max(0.1, Number(delayMatch[1]) / 1000) : 1;
  const probes = requestedProbes.length > 0 ? requestedProbes : ['D13'];
  const lines = [`${projectName} rev=${doc.rev} t     ${probes.join(' ')}`];
  let high = true;
  for (let t = 0; t <= dur + 1e-9; t += halfPeriod) {
    const v = high ? '1' : '0';
    lines.push(`${fmtDemoTime(t).padEnd(5)} ${probes.map(p => (p.startsWith('V(') ? (high ? '5' : '0') : v).padEnd(p.length)).join(' ').trimEnd()}`);
    high = !high;
  }
  if (mcu && /Serial\./.test(code)) {
    lines.push(`serial ${mcu.ref}: blink ready`);
  }
  return lines.join('\n');
}

/** Create an in-browser ?demo backend backed by @cadllm/core Doc with canned blink, button-led, and nand-led circuits. */
export function createDemoBackend(): DemoBackend {
  const resolver = buildPartResolver(DEMO_PARTS);
  const log: { rev: number; source: string; summary: string }[] = [];
  const listeners = new Set<(n: ChangedNotification) => void>();
  const installedPlugins = new Map<string, PluginStatusItem>([
    [
      DEMO_SENSOR_MANIFEST.id,
      {
        ...DEMO_SENSOR_MANIFEST,
        requestedPermissions: [...DEMO_SENSOR_MANIFEST.requestedPermissions],
        grantedPermissions: [...DEMO_SENSOR_MANIFEST.grantedPermissions],
        contributions: [...DEMO_SENSOR_MANIFEST.contributions],
      },
    ],
  ]);

  const blinkDoc = new Doc(resolver);
  const buttonDoc = new Doc(resolver);
  const nandDoc = new Doc(resolver);
  const ledPcbDoc = new Doc(resolver);

  let projectName = 'arduino-blink';
  const projects = new Map<string, Doc>([
    ['arduino-blink', blinkDoc],
    ['arduino-button-led', buttonDoc],
    ['nand-led-demo', nandDoc],
    ['led-pcb', ledPcbDoc],
  ]);

  const summarize = (info: TxInfo): string => {
    const d = info.delta;
    const items = [
      ...d.added.map(r => `+${r}`),
      ...d.removed.map(r => `-${r}`),
      ...d.changed.map(r => `~${r}`),
      ...d.netsAdded.map(n => `+${n}`),
      ...d.netsChanged.map(n => `~${n}`),
      ...(d.pcbNets.length ? [`pcb: ${d.pcbNets.map(n => `~${n}`).join(' ')}`] : []),
      ...info.notes,
    ];
    return items.join(' ');
  };

  const attachDoc = (name: string, target: Doc) => {
    target.on(info => {
      const summary = summarize(info);
      log.push({ rev: info.rev, source: info.source, summary });
      const note: ChangedNotification = {
        project: name,
        rev: info.rev,
        source: info.source,
        ...(info.label ? { label: info.label } : {}),
        delta: info.delta,
        summary,
      };
      for (const cb of listeners) cb(note);
    });
  };

  blinkDoc.transact(tx => {
    tx.addComponent({ ref: 'U1', part: 'arduino_uno', place: { sch: '12,14', bb: '-24,2' } });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' }, place: { sch: '28,12', bb: 'D10-D14' } });
    tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' }, place: { sch: '34,12', bb: 'E14-E16' } });
    tx.connect('D13', ['U1.D13', 'R1.1']);
    tx.connect('LA', ['R1.2', 'D1.A']);
    tx.connect('GND', ['D1.K', 'U1.GND1']);
    tx.setMeta('__code:U1', BLINK_CODE);
  }, { source: 'system', label: 'init' });

  buttonDoc.transact(tx => {
    tx.addComponent({ ref: 'U1', part: 'arduino_uno', place: { sch: '12,14', bb: '-24,2' } });
    tx.addComponent({ ref: 'SW1', part: 'button', props: { state: 'released' }, place: { sch: '26,6', bb: 'E4' } });
    tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' }, place: { sch: '26,12,90', bb: 'E8-E12' } });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '220' }, place: { sch: '32,14', bb: 'D18-D22' } });
    tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'green' }, place: { sch: '38,14', bb: 'E22-E24' } });
    tx.connect('5V', ['SW1.1', 'U1.5V']);
    tx.connect('D2', ['R2.1', 'SW1.2', 'U1.D2']);
    tx.connect('D13', ['R1.1', 'U1.D13']);
    tx.connect('LA', ['D1.A', 'R1.2']);
    tx.connect('GND', ['D1.K', 'R2.2', 'U1.GND1']);
    tx.setMeta('__code:U1', BUTTON_LED_CODE);
  }, { source: 'system', label: 'init' });

  nandDoc.transact(tx => {
    tx.addComponent({ ref: 'BAT1', part: 'battery', props: { voltage: '5V' }, place: { sch: '2,6', bb: '-6,4' } });
    tx.addComponent({ ref: 'SW1', part: 'button', props: { state: 'released' }, place: { sch: '8,4', bb: 'E4', pcb: '8,8' } });
    tx.addComponent({ ref: 'R2', part: 'res', props: { resistance: '10k' }, place: { sch: '8,10,90', bb: 'E8-E12', pcb: '8,18' } });
    tx.addComponent({ ref: 'U1', part: '74hc00', place: { sch: '18,6', bb: 'E14', pcb: '20,14' } });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '330' }, place: { sch: '28,6', bb: 'F18-F22', pcb: '32,10' } });
    tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red' }, place: { sch: '34,6,90', bb: 'F24-F26', pcb: '38,18' } });
    tx.connect('VCC', ['BAT1.+', 'SW1.1', 'U1.1A', 'U1.VCC']);
    tx.connect('IN', ['SW1.2', 'R2.1', 'U1.1B']);
    tx.connect('Y', ['U1.1Y', 'R1.1']);
    tx.connect('LA', ['R1.2', 'D1.A']);
    tx.connect('GND', ['BAT1.-', 'R2.2', 'U1.GND', 'D1.K']);
    tx.setBoard([[0, 0], [45, 0], [45, 28], [0, 28]]);
    tx.setPcbRules({ clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 });
  }, { source: 'system', label: 'init' });

  ledPcbDoc.transact(tx => {
    tx.addComponent({ ref: 'J1', part: 'dc_supply', props: { voltage: '5V' }, place: { sch: '4,8', bb: 'D4-D5', pcb: '5,7' } });
    tx.addComponent({ ref: 'R1', part: 'res', props: { resistance: '330', footprint: 'THT-axial' }, place: { sch: '14,8', bb: 'E8-E12', pcb: '15,7' } });
    tx.addComponent({ ref: 'D1', part: 'led', props: { color: 'red', footprint: 'LED_D5.0mm' }, place: { sch: '22,8', bb: 'E15-E17', pcb: '24,13' } });
    tx.connect('VCC', ['J1.+', 'R1.1']);
    tx.connect('LA', ['R1.2', 'D1.A']);
    tx.connect('GND', ['D1.K', 'J1.-']);
    tx.setBoard([[0, 0], [30, 0], [30, 20], [0, 20]]);
    tx.setPcbRules({ clearance: 0.2, track: 0.25, via: 0.6, drill: 0.3 });
    tx.addTrack({ net: 'VCC', layer: 'F', width: 0.35, points: [[5, 5.73], [9.92, 5.73], [9.92, 7]] });
    tx.addTrack({ net: 'LA', layer: 'F', width: 0.3, points: [[20.08, 7], [20.08, 10]] });
    tx.addVia({ net: 'LA', at: [20.08, 10] });
    tx.addTrack({ net: 'LA', layer: 'B', width: 0.3, points: [[20.08, 10], [22.73, 13]] });
  }, { source: 'system', label: 'init' });

  for (const [name, d] of projects) attachDoc(name, d);

  const curDoc = (): Doc => projects.get(projectName)!;

  const printRead = (place = false): string => {
    const q = curDoc().read;
    const comps = q.components().map(c => {
      const p = resolver.get(c.part);
      const vp = p?.valueProp;
      const tail: string[] = [];
      if (vp && c.props[vp]) tail.push(c.props[vp]!);
      for (const k of Object.keys(c.props).sort(naturalCompare)) {
        if (k !== vp && c.props[k] !== p?.props?.[k]?.default) tail.push(`${k}=${c.props[k]}`);
      }
      if (place) {
        for (const v of Object.keys(c.place).sort()) tail.push(`@${v}:${c.place[v]}`);
      }
      return [c.ref, c.part, ...tail].join(' ');
    });
    const nets = q.nets().map(n => `${n.name}: ${q.sortedPins(n).join(' ')}`);
    const body = [comps.join('\n'), nets.join('\n')].filter(Boolean).join('\n\n');
    return `${projectName} rev=${curDoc().rev}${body ? `\n${body}` : ' (empty)'}`;
  };

  const parseDemoPoint = (raw: string): [number, number] | undefined => {
    const parts = raw.split(',');
    if (parts.length !== 2) return undefined;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
  };

  const parseDemoPlaceMap = (toks: string[]): Record<string, string> => {
    const place: Record<string, string> = {};
    let i = 0;
    while (i < toks.length) {
      const t = toks[i]!;
      const c = t.indexOf(':');
      if (t.startsWith('@') && c > 1) {
        const viewKey = t.slice(1, c);
        const parts = [t.slice(c + 1)];
        i += 1;
        while (i < toks.length && !toks[i]!.startsWith('@') && !toks[i]!.includes('=')) {
          parts.push(toks[i]!);
          i += 1;
        }
        place[viewKey] = parts.filter(Boolean).join(' ');
      } else {
        i += 1;
      }
    }
    return place;
  };

  const applyDemoCnl = (cnl: string, source: 'user' | 'ai' | 'plugin' = 'user'): TxInfo => {
    const lines = cnl
      .split(/[\r\n;]+/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    return curDoc().transact(tx => {
      for (const line of lines) {
        const toks = line.split(/\s+/);
        const head = toks[0]!;
        if (head === '-tracks') {
          const target = toks[1];
          if (target === '*') tx.removePcbCopper();
          else if (target) tx.removePcbCopper(target);
          continue;
        }
        if (head === 'board') {
          if (toks.length === 2) {
            const rect = toks[1]!.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
            if (rect) {
              const w = Number(rect[1]);
              const h = Number(rect[2]);
              tx.setBoard([[0, 0], [w, 0], [w, h], [0, h]]);
              continue;
            }
          }
          const pts = toks.slice(1).map(parseDemoPoint).filter((p): p is [number, number] => Boolean(p));
          if (pts.length >= 3) tx.setBoard(pts);
          continue;
        }
        if (head === 'rules') {
          const rules: Partial<PcbRules> = {};
          for (const t of toks.slice(1)) {
            const eq = t.indexOf('=');
            if (eq > 0) {
              const k = t.slice(0, eq) as keyof PcbRules;
              const v = Number(t.slice(eq + 1));
              if (Number.isFinite(v) && v > 0) rules[k] = v;
            }
          }
          tx.setPcbRules(rules);
          continue;
        }
        if (head === 'track' && toks.length >= 6) {
          const net = toks[1]!;
          const layer = toks[2]!.toUpperCase() as PcbLayer;
          const width = Number(toks[3]);
          const points = toks.slice(4).map(parseDemoPoint).filter((p): p is [number, number] => Boolean(p));
          if (points.length >= 2) tx.addTrack({ net, layer, width, points });
          continue;
        }
        if (head === 'via' && toks.length >= 3) {
          const net = toks[1]!;
          const at = parseDemoPoint(toks[2]!);
          if (at) {
            let size: number | undefined;
            let drill: number | undefined;
            for (const t of toks.slice(3)) {
              const eq = t.indexOf('=');
              if (eq > 0) {
                const k = t.slice(0, eq);
                const v = Number(t.slice(eq + 1));
                if (Number.isFinite(v) && v > 0) {
                  if (k === 'size') size = v;
                  if (k === 'drill') drill = v;
                }
              }
            }
            tx.addVia({ net, at, ...(size !== undefined ? { size } : {}), ...(drill !== undefined ? { drill } : {}) });
          }
          continue;
        }
        if (line.startsWith('-')) {
          const colon = line.indexOf(':');
          if (colon > 1) {
            const net = line.slice(1, colon).trim();
            const pins = line.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
            tx.disconnect(net, pins);
          } else {
            const target = line.slice(1).trim();
            if (tx.component(target)) tx.removeComponent(target);
            else tx.removeNet(target);
          }
          continue;
        }
        if (line.startsWith('~')) {
          const ref = toks[0]!.slice(1);
          const props: Record<string, string | null> = {};
          const place: Record<string, string | null> = {};
          let i = 1;
          while (i < toks.length) {
            const t = toks[i]!;
            if (t.startsWith('@')) {
              const c = t.indexOf(':');
              if (c > 1) {
                const parsed = parseDemoPlaceMap(toks.slice(i));
                Object.assign(place, parsed);
              }
              break;
            }
            const eq = t.indexOf('=');
            if (eq > 0) props[t.slice(0, eq)] = t.slice(eq + 1) || null;
            i += 1;
          }
          tx.updateComponent(ref, { props, place });
          continue;
        }
        if (toks[0]!.includes(':')) {
          const c = toks[0]!.indexOf(':');
          const name = toks[0]!.slice(0, c);
          const after = toks[0]!.slice(c + 1);
          const pins = [...(after ? [after] : []), ...toks.slice(1)];
          tx.connect(name, pins);
          continue;
        }
        if (toks.length >= 2 && toks[1]!.startsWith('@')) {
          const place = parseDemoPlaceMap(toks.slice(1));
          tx.updateComponent(toks[0]!, { place });
          continue;
        }
        const [ref, partId, ...rest] = toks;
        if (!ref || !partId) continue;
        const p = resolver.get(partId);
        const props: Record<string, string> = {};
        const place: Record<string, string> = {};
        for (let i = 0; i < rest.length; i++) {
          const t = rest[i]!;
          if (t.startsWith('@')) {
            Object.assign(place, parseDemoPlaceMap(rest.slice(i)));
            break;
          } else if (t.includes('=')) {
            const eq = t.indexOf('=');
            props[t.slice(0, eq)] = t.slice(eq + 1);
          } else if (p?.valueProp) {
            props[p.valueProp] = t;
          }
        }
        if (tx.component(ref)) tx.updateComponent(ref, { part: partId, props, place });
        else tx.addComponent({ ref, part: partId, props, place });
      }
    }, { source });
  };

  return {
    onChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    simulateAiEdit() {
      const d = curDoc();
      if (projectName === 'led-pcb') {
        const gnd = d.read.net('GND');
        const hasGndTrack = (d.read.circuit.pcb?.tracks ?? []).some(t => gnd && t.net === gnd.id);
        if (!hasGndTrack) {
          applyDemoCnl('track GND B 0.35 25.27,13 25.27,16 5,16 5,8.27', 'ai');
        } else {
          const r1 = d.read.component('R1');
          const nextVal = r1?.props.resistance === '470' ? '330' : '470';
          applyDemoCnl(`~R1 resistance=${nextVal}`, 'ai');
        }
        return;
      }
      const u1 = d.read.component('U1');
      if (u1?.part === 'arduino_uno') {
        const cur = d.read.circuit.meta[`__code:${u1.ref}`] ?? BLINK_CODE;
        const next = cur.includes('delay(1000)')
          ? cur.replace(/delay\(1000\)/g, 'delay(500)')
          : cur.includes('delay(500)')
            ? cur.replace(/delay\(500\)/g, 'delay(1000)')
            : `${cur}\n// AI updated`;
        d.transact(tx => {
          tx.setMeta(`__code:${u1.ref}`, next);
          tx.notes.push(`code ${u1.ref}`);
        }, { source: 'ai' });
        return;
      }
      const r1 = d.read.component('R1');
      const nextVal = r1?.props.resistance === '470' ? '330' : '470';
      applyDemoCnl(`~R1 resistance=${nextVal}`, 'ai');
    },
    async state(): Promise<StateResponse> {
      const d = curDoc();
      const used: Record<string, PartDef> = {};
      for (const c of d.read.components()) {
        const p = resolver.get(c.part);
        if (p) used[p.id] = p;
      }
      return {
        project: projectName,
        rev: d.rev,
        projects: [...projects.entries()].map(([name, pd]) => ({ name, rev: pd.rev })),
        circuit: d.toJSON(),
        parts: used,
      };
    },
    async library(): Promise<PartDef[]> {
      return DEMO_PARTS;
    },
    async call<T = string>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const d = curDoc();
      switch (method) {
        case 'read': {
          if (typeof params.code === 'string') {
            const comp = d.read.requireComponent(params.code);
            const code = d.read.circuit.meta[`__code:${comp.ref}`];
            return (
              code !== undefined
                ? `${projectName} rev=${d.rev} [code ${comp.ref}]\n${code}`
                : `${projectName} rev=${d.rev} ${comp.ref}: no code`
            ) as T;
          }
          return printRead(Boolean(params.place)) as T;
        }
        case 'edit': {
          if (params.code && typeof params.code === 'object') {
            const codeEdit = params.code as { ref: string; text: string };
            const info = d.transact(tx => {
              const comp = tx.requireComponent(codeEdit.ref);
              const key = `__code:${comp.ref}`;
              const norm = codeEdit.text.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
              if (norm.trim() === '') {
                tx.setMeta(key, null);
                tx.notes.push(`code -${comp.ref}`);
              } else {
                tx.setMeta(key, norm);
                tx.notes.push(`code ${comp.ref}`);
              }
            }, { source: 'user' });
            return `ok rev=${info.rev} ${summarize(info)}`.trim() as T;
          }
          const info = applyDemoCnl(String(params.cnl ?? ''), 'user');
          return `ok rev=${info.rev} ${summarize(info)}`.trim() as T;
        }
        case 'find': {
          if (typeof params.id === 'string' && params.id.trim()) {
            const ids = params.id.split(/[\s,]+/).filter(Boolean);
            return ids.map(id => {
              const p = resolver.get(id);
              if (!p) throw new Error(`unknown part ${id} · search with find`);
              return `${p.id}  ${p.name} · ${p.summary} · ref ${p.refPrefix}\npins ${p.pins.map(pin => `${pin.id}:${pin.name}`).join(' · ')}`;
            }).join('\n\n') as T;
          }
          const q = String(params.q ?? '').trim().toLowerCase();
          const matches = DEMO_PARTS.filter(p =>
            !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q) || p.category.includes(q),
          );
          if (!matches.length) return `no parts match "${q}" · categories: board io logic passive source` as T;
          return matches.map(p => `${p.id}  ${p.summary}  ${p.pins.length}p${p.footprints?.length ? ` ${p.footprints.join('/')}` : ''}`).join('\n') as T;
        }
        case 'ext': {
          const op = String(params.op ?? 'list');
          if (op === 'list') {
            const tools: string[] = [];
            for (const plugin of installedPlugins.values()) {
              if (plugin.state !== 'loaded') continue;
              for (const tool of plugin.contributes.tools ?? []) {
                tools.push(`${tool.name}  ${tool.summary}  (${plugin.id}@${plugin.version})`);
              }
            }
            return (tools.length ? tools.join('\n') : 'no plugin tools installed') as T;
          }
          if (op === 'call' && params.name === 'calc_divider' && installedPlugins.has('org.example.sensors')) {
            const args = (params.args && typeof params.args === 'object' ? params.args : {}) as Record<string, unknown>;
            const vin = Number(args.vin ?? 5);
            const vout = Number(args.vout ?? 3.3);
            if (!Number.isFinite(vin) || !Number.isFinite(vout) || vout <= 0 || vout >= vin) {
              throw new Error('calc_divider requires 0 < vout < vin');
            }
            const r1 = 5100;
            const r2 = Math.round((r1 * vout) / (vin - vout));
            const actual = (vin * r2) / (r1 + r2);
            const errPct = ((actual - vout) / vout) * 100;
            return `R1=5.1k R2=${r2} Vout=${actual.toFixed(3)}V err=${errPct.toFixed(2)}%` as T;
          }
          throw new Error(`unknown plugin tool ${String(params.name ?? '')}`);
        }
        case 'help': {
          return [
            'Sim commands: dc · tran 10m · ac dec 10 10 100k · logic in=SW1 out=Y · run 4s probes=D13 · test',
            'Plugin tools: ext op=list · ext op=call name=<tool>',
          ].join('\n') as T;
        }
        case 'plugins.list': {
          return [...installedPlugins.values()].sort((a, b) => a.id.localeCompare(b.id)) as T;
        }
        case 'plugins.index': {
          return DEMO_REGISTRY_INDEX.map(entry => ({
            ...entry,
            versions: entry.versions.map(v => ({ ...v, permissions: [...v.permissions], contributes: [...v.contributes] })),
          })) as T;
        }
        case 'plugins.install': {
          const id = String(params.id ?? '').trim();
          const entry = DEMO_REGISTRY_INDEX.find(p => p.id === id);
          if (!entry) throw new Error(`unknown plugin ${id}`);
          const ver = entry.versions[entry.versions.length - 1]!;
          const item: PluginStatusItem = id === DEMO_SENSOR_MANIFEST.id
            ? {
                ...DEMO_SENSOR_MANIFEST,
                requestedPermissions: [...DEMO_SENSOR_MANIFEST.requestedPermissions],
                grantedPermissions: [],
                contributions: [...DEMO_SENSOR_MANIFEST.contributions],
              }
            : {
                id: entry.id,
                name: entry.name,
                version: ver.version,
                summary: entry.summary,
                publisher: entry.publisher,
                license: entry.license ?? 'MIT',
                state: 'loaded',
                requestedPermissions: [...ver.permissions],
                grantedPermissions: [],
                contributions: [...ver.contributes],
                contributes: {
                  ...(ver.contributes.includes('tools') ? { tools: [{ name: 'probe_rails', summary: 'inspect power rail voltages' }] } : {}),
                },
              };
          installedPlugins.set(id, item);
          return item as T;
        }
        case 'plugins.grant': {
          const id = String(params.id ?? '').trim();
          const cur = installedPlugins.get(id);
          if (!cur) throw new Error(`plugin ${id} is not installed`);
          const perms = Array.isArray(params.permissions) ? params.permissions.filter((x): x is string => typeof x === 'string') : [];
          const next = new Set(cur.grantedPermissions);
          for (const p of perms) {
            if (!cur.requestedPermissions.includes(p)) throw new Error(`permission "${p}" is not requested by plugin ${id}`);
            next.add(p);
          }
          cur.grantedPermissions = [...next].sort();
          return cur as T;
        }
        case 'plugins.revoke': {
          const id = String(params.id ?? '').trim();
          const cur = installedPlugins.get(id);
          if (!cur) throw new Error(`plugin ${id} is not installed`);
          const toRevoke = Array.isArray(params.permissions) ? new Set(params.permissions) : null;
          cur.grantedPermissions = toRevoke
            ? cur.grantedPermissions.filter(p => !toRevoke.has(p)).sort()
            : [];
          return cur as T;
        }
        case 'plugins.remove': {
          const id = String(params.id ?? '').trim();
          const removed = installedPlugins.delete(id);
          return { id, removed } as T;
        }
        case 'plugins.panel': {
          const id = String(params.id ?? '').trim();
          const panelId = String(params.panel ?? '').trim();
          const cur = installedPlugins.get(id);
          if (!cur) throw new Error(`plugin ${id} is not installed`);
          const panelDef = cur.contributes.panels?.find(p => p.id === panelId);
          if (!panelDef) throw new Error(`unknown panel "${panelId}" for plugin "${id}"`);
          const payload: PluginPanelPayload = {
            id,
            panel: panelDef.id,
            title: panelDef.title,
            html: DEMO_SENSOR_PANEL_HTML,
          };
          return payload as T;
        }
        case 'plugins.panelEdit': {
          const id = String(params.id ?? '').trim();
          const cnl = String(params.cnl ?? '').trim();
          const cur = installedPlugins.get(id);
          if (!cur) throw new Error(`plugin ${id} is not installed`);
          if (!cur.grantedPermissions.includes('project:write')) {
            throw new Error(`permission denied: plugin "${id}" does not have project:write`);
          }
          if (!cnl) throw new Error('plugins.panelEdit requires cnl');
          const info = applyDemoCnl(cnl, 'plugin');
          return `ok rev=${info.rev} ${summarize(info)}`.trim() as T;
        }
        case 'check': {
          const basic = basicChecks(d.read);
          const hasPcb = Boolean(d.read.circuit.pcb) || d.read.components().some(c => c.place.pcb !== undefined);
          const pcbIssues = hasPcb ? checkPcbDrc(d.read, true).issues : [];
          const issues = [...basic, ...pcbIssues];
          const errs = issues.filter(i => i.level === 'error').length;
          return [`${projectName} rev=${d.rev} ${errs} err ${issues.length - errs} warn`, ...issues.map(i => `${i.level === 'error' ? 'err ' : 'warn'} ${i.message}`)].join('\n') as T;
        }
        case 'sim':
          return runCannedDemoSim(d, projectName, String(params.run ?? '')) as T;
        case 'history': {
          const op = String(params.op ?? 'log');
          if (op === 'undo') {
            const info = d.undo('user');
            return (info ? `ok rev=${info.rev} undo` : `nothing to undo (${projectName} rev=${d.rev})`) as T;
          }
          if (op === 'redo') {
            const info = d.redo('user');
            return (info ? `ok rev=${info.rev} redo` : `nothing to redo (${projectName} rev=${d.rev})`) as T;
          }
          return log.slice(-10).reverse().map(e => `rev ${e.rev} ${e.source}: ${e.summary}`).join('\n') as T;
        }
        case 'project': {
          const op = String(params.op ?? 'list');
          if (op === 'new') {
            const name = String(params.name ?? `demo-${projects.size + 1}`);
            const nd = new Doc(resolver);
            attachDoc(name, nd);
            projects.set(name, nd);
            projectName = name;
            return `ok project=${name} rev=0` as T;
          }
          if (op === 'use' && typeof params.name === 'string' && projects.has(params.name)) {
            projectName = params.name;
            return `ok project=${projectName} rev=${curDoc().rev}` as T;
          }
          if (op === 'list') {
            return [...projects.entries()].map(([n, pd]) => `${n === projectName ? '*' : ' '} ${n} rev=${pd.rev}`).join('\n') as T;
          }
          return `demo mode: project ${op} simulated` as T;
        }
        case 'layout': {
          const v = String(params.view ?? 'sch') as ViewId;
          const op = params.op === 'route' ? 'route' : 'place';
          if (op === 'route') {
            if (v !== 'pcb') throw new Error('op=route is only supported for view=pcb');
            const nets = typeof params.nets === 'string' ? params.nets.split(/[\s,]+/).filter(Boolean) : undefined;
            const r = routePcbWithFallback(d.read, { ...(nets?.length ? { nets } : {}), ...(params.all ? { reroute: true } : {}) });
            const info = d.transact(tx => {
              if (params.all) tx.removePcbCopper();
              const pcbData = tx.ensurePcb();
              pcbData.tracks.push(...r.tracks);
              pcbData.vias.push(...r.vias);
            }, { label: 'route pcb', source: 'user' });
            return `ok rev=${info.rev} routed ${r.tracks.length} tracks, ${r.vias.length} vias` as T;
          }
          const res = v === 'pcb'
            ? autoPlacePcbWithFallback(d.read, { ...(params.all ? { all: true } : {}) })
            : VIEWS[v].autoPlace(d.read, {});
          const lines = Object.entries(res.place).map(([ref, pos]) => `${ref} @${v}:${pos}`);
          if (lines.length) applyDemoCnl(lines.join('\n'), 'user');
          return `ok placed ${lines.length} in ${v}` as T;
        }
        case 'export': {
          const format = String(params.format ?? 'fab');
          const out = `${projectName}-${format === 'fab' ? 'fab.zip' : format}`;
          return `${out}\nok exported ${format} (demo)` as T;
        }
        default:
          throw new Error(`method not found: ${method}`);
      }
    },
  };
}
