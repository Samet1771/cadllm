// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export function pcbStyle(theme: 'light' | 'dark'): string {
  const dark = theme === 'dark';
  const bg = dark ? '#0b1120' : '#eef2f6';
  const boardFill = dark ? '#0f3d24' : '#14532d';
  const outline = dark ? '#fde047' : '#eab308';
  const mask = dark ? '#072414' : '#0b351d';
  const cuF = dark ? '#f87171' : '#dc2626';
  const cuB = dark ? '#60a5fa' : '#2563eb';
  const cuTH = dark ? '#fbbf24' : '#d97706';
  const drill = dark ? '#0b1120' : '#1e293b';
  const silkF = dark ? '#f8fafc' : '#ffffff';
  const silkB = dark ? '#94a3b8' : '#cbd5e1';
  const refF = dark ? '#f8fafc' : '#ffffff';
  const refB = dark ? '#cbd5e1' : '#e2e8f0';
  const valTxt = dark ? '#cbd5e1' : '#d1fae5';
  const courtyard = dark ? '#64748b' : '#94a3b8';
  const rats = dark ? '#fbbf24' : '#facc15';
  const hl = dark ? '#38bdf8' : '#0284c7';
  const muted = dark ? '#94a3b8' : '#64748b';

  const sans = "'Segoe UI',Arial,'Liberation Sans',sans-serif";
  const mono = "Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";

  return [
    `.pcb-bg{fill:${bg}}`,
    `.pcb-board{fill:${boardFill};stroke:none}`,
    `.pcb-outline{fill:none;stroke:${outline};stroke-width:1.5;stroke-linejoin:round}`,
    `.pcb-mask{fill:${mask};stroke:none}`,
    `.pcb-pad-f{fill:${cuF};stroke:none}`,
    `.pcb-pad-b{fill:${cuB};stroke:none}`,
    `.pcb-pad-th{fill:${cuTH};stroke:none}`,
    `.pcb-drill{fill:${drill};stroke:none}`,
    `.pcb-track-f{fill:none;stroke:${cuF};stroke-linecap:round;stroke-linejoin:round}`,
    `.pcb-track-b{fill:none;stroke:${cuB};stroke-linecap:round;stroke-linejoin:round}`,
    `.pcb-via{fill:${cuTH};stroke:none}`,
    `.pcb-silk-f{fill:none;stroke:${silkF};stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}`,
    `.pcb-silk-b{fill:none;stroke:${silkB};stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:2 1.5}`,
    `.pcb-ref{fill:${refF};font-family:${mono};font-size:10px;font-weight:700}`,
    `.pcb-ref-b{fill:${refB};font-family:${mono};font-size:10px;font-weight:700}`,
    `.pcb-val{fill:${valTxt};font-family:${mono};font-size:7.5px;font-weight:500}`,
    `.pcb-courtyard{fill:none;stroke:${courtyard};stroke-width:0.8;stroke-dasharray:3 2}`,
    `.pcb-rats{fill:none;stroke:${rats};stroke-width:1.2;stroke-dasharray:4 3;stroke-linecap:round}`,
    `.pcb-empty{fill:${muted};font-family:${sans};font-size:12px;font-weight:500}`,
    `.pcb-comp.hl .pcb-pad-f,.pcb-comp.hl .pcb-pad-b,.pcb-comp.hl .pcb-pad-th{stroke:${hl};stroke-width:2}`,
    `.pcb-comp.hl .pcb-silk-f,.pcb-comp.hl .pcb-silk-b,.pcb-comp.hl .pcb-courtyard{stroke:${hl};stroke-width:2}`,
    `.pcb-comp.hl .pcb-ref,.pcb-comp.hl .pcb-ref-b{fill:${hl}}`,
    `.pcb-net.hl .pcb-track-f,.pcb-net.hl .pcb-track-b,.pcb-net.hl .pcb-rats{stroke:${hl}}`,
    `.pcb-net.hl .pcb-via{fill:${hl}}`,
  ].join('');
}
