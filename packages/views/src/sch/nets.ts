// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { Net, Query } from '@cadllm/core';

const GROUND_NAME_RE = /^(GND|AGND|DGND|PGND|VSS|VEE|V-|0V)$/i;
const POWER_NAME_RE = /^(VCC|VDD|AVDD|DVDD|V\+|VBUS|VBAT|VIN|VPP|VREF|\+?\d+(?:\.\d+)?V\d*|3V3|5V|12V|24V)$/i;

export function resolveSchFamily(part: { id: string; category: string; views?: { sch?: string } }): string {
  if (part.views?.sch) return part.views.sch;
  if (part.category === 'logic' || part.category === 'ic') return 'ic';
  const byId: Record<string, string> = {
    res: 'resistor',
    cap: 'capacitor',
    cap_pol: 'capacitor_pol',
    inductor: 'inductor',
    pot: 'pot',
    diode: 'diode',
    zener: 'zener',
    led: 'led',
    battery: 'battery',
    dc_supply: 'vsource',
    switch_spst: 'switch',
    button: 'button',
    buzzer: 'buzzer',
    logic_probe: 'probe',
    vcc_symbol: 'vcc',
    gnd_symbol: 'gnd',
    npn: 'npn',
    pnp: 'pnp',
    nmos: 'nmos',
    arduino_uno: 'board',
    breadboard_half: 'none',
    breadboard_full: 'none',
  };
  return byId[part.id] ?? 'ic';
}

export function isGroundNet(q: Query, net: Net): boolean {
  if (GROUND_NAME_RE.test(net.name)) return true;
  return net.pins.some(k => {
    const [cid] = k.split(':') as [string, string];
    const comp = q.circuit.components[cid];
    if (!comp) return false;
    const part = q.parts.get(comp.part);
    return part ? resolveSchFamily(part) === 'gnd' : false;
  });
}

export function isPowerNet(q: Query, net: Net): boolean {
  if (isGroundNet(q, net)) return true;
  if (POWER_NAME_RE.test(net.name)) return true;
  return net.pins.some(k => {
    const [cid] = k.split(':') as [string, string];
    const comp = q.circuit.components[cid];
    if (!comp) return false;
    const part = q.parts.get(comp.part);
    return part ? resolveSchFamily(part) === 'vcc' : false;
  });
}
