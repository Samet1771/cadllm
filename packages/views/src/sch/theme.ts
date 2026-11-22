// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

/**
 * Single CSS <style> block per SVG document so the UI can restyle themes cleanly.
 * Uses simple SVG CSS selectors compatible with both browsers and resvg.
 */
export function schStyle(theme: 'light' | 'dark'): string {
  const dark = theme === 'dark';
  const bg = dark ? '#0f172a' : '#ffffff';
  const sym = dark ? '#e2e8f0' : '#1e293b';
  const boxFill = dark ? '#1e293b' : '#f8fafc';
  const wire = dark ? '#4ade80' : '#15803d';
  const pwr = dark ? '#f87171' : '#b91c1c';
  const gnd = dark ? '#94a3b8' : '#334155';
  const ref = dark ? '#f8fafc' : '#0f172a';
  const val = dark ? '#94a3b8' : '#475569';
  const pinName = dark ? '#cbd5e1' : '#334155';
  const pinDot = dark ? '#64748b' : '#64748b';
  const rats = dark ? '#fb923c' : '#d97706';
  const hl = dark ? '#fbbf24' : '#2563eb';
  const muted = dark ? '#94a3b8' : '#64748b';

  const sans = "'Segoe UI',Arial,'Liberation Sans',sans-serif";
  const mono = "Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";

  return [
    `.bg{fill:${bg}}`,
    `.sym{stroke:${sym};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.sym-fill{stroke:${sym};stroke-width:1.6;fill:${sym};stroke-linecap:round;stroke-linejoin:round}`,
    `.ic-box{stroke:${sym};stroke-width:1.6;fill:${boxFill};stroke-linejoin:round}`,
    `.pin{fill:${pinDot};stroke:none;opacity:0.45}`,
    `.pin-hit{fill:transparent;stroke:none}`,
    `.wire{stroke:${wire};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.junc{fill:${wire};stroke:none}`,
    `.pwr-wire{stroke:${pwr};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.pwr-sym{stroke:${pwr};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.pwr-lbl{fill:${pwr};font-family:${mono};font-size:8px;font-weight:600}`,
    `.gnd-wire{stroke:${gnd};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.gnd-sym{stroke:${gnd};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `.gnd-lbl{fill:${gnd};font-family:${mono};font-size:7.5px;font-weight:600}`,
    `.ratsnest{stroke:${rats};stroke-width:1.2;stroke-dasharray:4 3;fill:none}`,
    `.lbl-ref{fill:${ref};font-family:${sans};font-size:8.5px;font-weight:600}`,
    `.lbl-val{fill:${val};font-family:${mono};font-size:7.5px;font-weight:400}`,
    `.pin-lbl{fill:${pinName};font-family:${mono};font-size:7.5px;font-weight:500}`,
    `.sym-mark{fill:${sym};font-family:${mono};font-size:7.5px;font-weight:600}`,
    `.empty-msg{fill:${muted};font-family:${sans};font-size:11px;font-weight:500}`,
    `.hl .sym,.hl .ic-box,.hl .wire,.hl .pwr-wire,.hl .pwr-sym,.hl .gnd-wire,.hl .gnd-sym,.hl .ratsnest{stroke:${hl};stroke-width:2.6}`,
    `.hl .sym-fill,.hl .junc{fill:${hl};stroke:${hl}}`,
    `.hl .lbl-ref,.hl .lbl-val,.hl .pwr-lbl,.hl .gnd-lbl{fill:${hl}}`,
    `.hl .pin{fill:${hl};opacity:0.9}`,
  ].join('');
}
