// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';
import type { Library } from '@cadllm/library';

const TOPICS: Record<string, string> = {
  edit: `CNL edit lines (one atomic batch; ";" or newline separates):
R1 res 330            add/upsert: <ref> <part> [value] [key=val] [@bb:E10]
R1 res 1k             same ref again = change part/value/props
~R1 resistance=470    change props only (key= deletes)
-R1                   remove component
VCC: BAT1.+ R1.1      connect pins (net created if new; unnamed pins: N: …)
-VCC: R1.1            disconnect pins
-VCC                  delete net
mv R1 R9              rename ref or net; mv N3 VCC merges N3 into VCC
board 50x40           PCB board rectangle (or polygon: board 0,0 50,0 50,40 0,40)
rules clearance=0.2 track=0.25 via=0.6 drill=0.3
track VCC F 0.4 10,10 20,10   add PCB track (F|B, width mm, >=2 points)
via VCC 20,15         add PCB via ([size=...] [drill=...])
-tracks VCC | *       remove PCB tracks/vias for net (or * for all)
pins: REF.PIN by number, name or alias (U1.1 = U1.1A, D1.A = D1.anode)
values: SI with RKM ok (4k7 2.2u 10meg 330); quote values with spaces.
Joining two named nets is refused (net_short) – use mv to merge on purpose.`,
  sim: `sim run="<analysis>[; expect …]"
dc                       DC operating point (op = dc). probes=V(LA),I(D1)
                         probes: V(NET) V(REF.PIN) I(REF); logic ICs first; SPICE fallback for BJTs/opamps/555
tran <stop> [step=…]     SPICE transient; summarizes min/max/final/freq (probes=V(…),I(…))
ac <dec|oct|lin> <pts> <f0> <f1> [probes=…]
                         SPICE AC sweep; summarizes start/stop gain and -3 dB point
run <dur> [press=SW1@0.5s-1s,…] [probes=…]
                         mixed MCU + digital + analog co-sim (compiles [code REF])
logic in=SW1,SW2 out=Y   truth table over switches/buttons
logic clock=SW1 reset=SW2 cycles=4 period=1u out=Q1,Q0
                         clocked run, one row per cycle (0 = after reset); add "trace" for transitions
logic out=Y              settled values with current switch states
expect <subj> <op> <val> | <min>..<max> | expect table
                         subj: V(LA), I(D1), D13@0.75s, or min/max/avg/final/rms/freq/period/duty/rise/fall(probe)
test [name*]             run the project's [tests] (see help tests)`,
  tests: `Project tests (edit tests="…" replaces them; saved in [tests]):
test "led current"
  dc
  expect I(D1) 8m..15m
test "blink"
  run 4s probes=D13
  expect period(D13) 1.9s..2.1s
test "nand"
  logic in=SW1 out=U1.1Y
  expect table
    0 -> 1
    1 -> 0
Supports dc/op, logic, tran, ac, run (with [code REF] sections).
Run: sim run="test" or sim run="test led*". cli: cadllm test file.cnl`,
  project: `project op=new|open|save|list|use|fork|merge|close [name] [path]
Edits go to the current project; the first edit creates "untitled".
fork = sandbox copy (becomes current); merge = write the fork back into its parent.
read since=<rev> shows what changed (e.g. by a human in the UI).
history op=undo|redo|log [n].`,
  views: `Schematic and breadboard wires are derived; PCB tracks/vias are stored copper.
layout view=sch|bb|pcb [refs=R1,D1] [all=true]   auto-place parts
layout view=pcb op=route [nets=VCC,GND]          autoroute PCB nets
render view=sch|bb|pcb [select=U1,R2]            PNG to look at
export format=gerber|drill|fab|kicad|bom|pnp|svg [view=...] [path=...]
place by hand in edit lines:
  R1 @sch:12,4,90        schematic grid x,y[,rot][,m] (rot 0/90/180/270, m = mirror)
  U1 @bb:E10             breadboard: DIP pin 1 at E10, straddling the channel
  R1 @bb:F20-F24         2-pin part between two holes; holes A1..J30, rails T+1 T-1 B+1 B-1
  BAT1 @bb:-8,2          off-board part, in hole pitches from the board's top-left
  U1 @pcb:12.7,8,90 top  PCB placement in mm, clockwise deg, side (top|bottom)
Breadboard strips (A-E, F-J per column) and rails connect pins; jumpers are added for the rest.
check reports bb_short on breadboard and PCB DRC/connectivity issues when PCB data exists.`,
  examples: `LED with resistor (5 V, ~9 mA):
BAT1 battery 5; R1 res 330; D1 led red
VCC: BAT1.+ R1.1; LA: R1.2 D1.A; GND: D1.K BAT1.-
check: sim run="dc; expect I(D1) < 20m"

NAND with button input:
BAT1 battery 5; SW1 button; R2 res 10k; U1 74hc00
VCC: BAT1.+ U1.VCC U1.1A SW1.1; IN: SW1.2 R2.1 U1.1B; GND: BAT1.- U1.GND R2.2; Y: U1.1Y
check: sim run="logic in=SW1 out=Y"

2-bit ripple counter (74hc74; buttons with pull-downs/ups for clock and reset):
BAT1 battery 5; U1 74hc74; SW1 button; R1 res 10k; SW2 button; R2 res 10k
VCC: BAT1.+ U1.VCC U1.1PRE U1.2PRE SW1.1 R2.2; GND: BAT1.- U1.GND R1.2 SW2.2
CLK: SW1.2 R1.1 U1.1CLK; RST: U1.1CLR U1.2CLR R2.1 SW2.1
Q0: U1.1Q; Q0N: U1.1QN U1.1D U1.2CLK; Q1: U1.2Q; Q1N: U1.2QN U1.2D
check: sim run="logic clock=SW1 reset=SW2 cycles=4 out=Q1,Q0"`,
};

export function help(topic: string | undefined, lib: Library): string {
  const t = topic?.trim().toLowerCase();
  if (!t) {
    return `CadLLM: circuits as text (CNL). Tools: project read edit find part check sim layout render export history help.
Typical: find → part → edit (CNL lines) → sim (dc/logic + expect) → fix → project save.
Topics: help topic=edit|sim|tests|project|views|examples|parts
${TOPICS.examples!.split('\n\n')[0]}`;
  }
  if (t === 'parts') {
    const byCat = new Map<string, string[]>();
    for (const p of lib.all()) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p.id]);
    return [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, ids]) => `${c}: ${ids.join(' ')}`).join('\n');
  }
  if (t === 'cnl' || t === 'grammar') return TOPICS.edit!;
  const text = TOPICS[t];
  if (!text) throw new CadError('invalid', `no help topic ${topic}`, `topics: ${[...Object.keys(TOPICS), 'parts'].join(' ')}`);
  return text;
}
