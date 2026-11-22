# M0 Plan: Engine + MCP

Goal (from FOUNDATION §11): an agent builds **and verifies** an LED circuit and a 2-bit counter in ≤ 6 MCP calls, with no UI.

## Status

| Package | State |
|---|---|
| `core` | ✅ Done: types, Query, Tx (transactions), Doc (revisions, undo/redo, `since`), `basicChecks`, `parseSI`. 33 tests. |
| `dsl` | ✅ Done: `parseCnl` (sections + `[tests]` AST), `applyEdit` (all line errors, atomic), `printCircuit` (detail 0/1/2, select, place), `printDelta`, `loadCircuit`/`saveCnl` (exact round trip), `examples/nand-led.cnl`. 14 tests. |
| `library` + `parts/` | ✅ Done: 33 parts (pinouts checked against TI/onsemi datasheets), `loadLibrary`/`createLibrary`, ranked `search`, `summaryLine`, `validatePart`, generator script. 7 tests. |
| `sim-digital` | ✅ Done: 4-state event sim with strong/weak drive, 74hc00/02/04/08/32/86/74/161/595 models, `simulate`, `clockStimulus`, `truthTable`, `formatTransitions`/`formatTruthTable`, oscillation detection. 24 tests. |
| `sim-analog` | ✅ Done: MNA DC op (NR + pnjlim, gmin and source stepping), R/POT/V/SW/C/L/diode/LED/zener, logic-IC DC bridge via `opts.logic`, floating-net/loop/singular errors, `formatOp`; `NGSPICE-SPIKE.md` (keep own solver for DC, try `eecircuit-engine` for M2). 37 tests. |
| `engine` | ✅ Done: projects (new/open/save/list/use/fork/merge/close), text tools, file and ad-hoc test runner (dc with logic ICs solved first, truth tables, clocked runs with reset), per-project history log. 13 tests. |
| `mcp` | ✅ Done: 9 tools (project read edit find part check sim history help), stdio, ≈870 schema tokens. |
| `cli` | ✅ Done: `cadllm mcp`, `cadllm test <file> [name]`, `cadllm bench [-v]`. Benchmark + stdio tests. |

### M0 goal: measured
`cadllm bench` (≈4 chars/token; budgets enforced in `packages/cli/test/bench.test.ts`):

| Task | Calls | Tokens (in + out) |
|---|---|---|
| Tool schemas (paid per request) | – | ≈870 |
| 5 V LED, prove I < 20 mA | 5 | ≈140 |
| 2-bit counter, verify the count sequence | 4 | ≈280 |

### Decisions made in WP5
- `sim` takes one `run` string in test-body syntax (`dc; expect I(D1) < 20m`), so the ad-hoc and file test languages are the same. `run="test [name*]"` runs the file's tests.
- Clocked logic: `logic clock=SW1 reset=SW2 cycles=4 period=1u out=Q1,Q0` prints one row per cycle (0 = after reset), checked with `expect table` rows `<cycle> -> <outs>`. Add `trace` for a transition table.
- Tests are edited with `edit tests="…"` (replaces the whole section).
- The first edit auto-creates project `untitled`. `fork` + `merge` give sandboxes; `merge` is one undoable revision on the parent.
- Edit results show all errors but only warnings about touched items, so unused-gate warnings don't repeat on every edit.
- Values that round onto an expect bound are printed with more digits (`19.998m < 20m`, not `20m < 20m`).
- Core: `output_conflict` now needs at least one `output` pin (two `power_out` on GND is normal); `Doc.replace()` for merges; `errorText()`.

### Open items
- `sim-digital` supports a per-instance `props.delay`, but core rejects props the part doesn't declare. Add `delay` to logic parts, or drop the feature.
- Transistors, NE555 and LM358 have no analog model yet (`operatingPoint` throws a clear error). `tran`/`ac` are not available. This is M2 or ngspice work.
- `layout`, `render`, `export`, `ext` tools are M1+.
- `arduino_uno` GND pins have ids `GND1..3` and names `GND`/`GND2`/`GND3`, because pin names must be unique. Breadboard strip connectivity isn't modeled yet (layout, M1).
- Token counts are a chars/4 estimate. Run the benchmark with real agents (tokens-to-success per model) before M1.
- The ~40-part target came in at 33. Add common variants (1N4007, BC547, 74hc138, headers) when needed.

## Ground rules for every work package
- **Read first:** `docs/FOUNDATION.md` (especially §3 CNL and §4 MCP), `packages/core/src/*.ts` (the contract), `packages/core/test/doc.test.ts` (style).
- **Own only your package folder** (plus `parts/` for WP2). Don't edit `core`. If core needs a change, say so in the reply instead.
- **TypeScript runs natively on Node 24.** Erasable syntax only: no `enum`, `namespace` or constructor parameter properties. Imports use `.ts` extensions. Packages export `./src/index.ts` and are named `@cadllm/<pkg>`. Every source file starts with the SPDX header used in core.
- **No new runtime dependencies** without saying why (dev dependencies for tests are fine).
- **Deterministic output** everywhere: sorted, stable, no timestamps or randomness.
- **Done when:** `npm run check` passes at the repo root, and the reply lists the files changed, the public API and any open questions.

## Shared part contract (WP2 implements it; WP1/WP3/WP4 rely on it)
Packages are built in parallel, so DSL and sim tests use **local fixture PartDefs** (`test/fixtures.ts`) that copy these ids, pin names, props and sim refs exactly. Pin = `id:name (aliases)`.

| id | pins | props (default) · valueProp | sim refs |
|---|---|---|---|
| res | 1:1, 2:2 | resistance (1k) · resistance | spice R, logic pull |
| cap / cap_pol | 1:1, 2:2 / 1:+ (pos), 2:- (neg) | capacitance (100n / 10u) · capacitance | spice C |
| inductor | 1:1, 2:2 | inductance (10u) · inductance | spice L |
| pot | 1:1, 2:W (wiper), 3:3 | resistance (10k) · resistance; position 0..1 (0.5) = fraction from pin 1 to 3 | spice POT |
| led | 1:A (anode, +), 2:K (cathode, -) | color enum red green blue yellow white (red) · color | spice LED |
| diode / zener | 1:A (anode, +), 2:K (cathode, -) | zener: voltage (5.1) · voltage | spice D1N4148 / DZ |
| battery / dc_supply | 1:+ (pos), 2:- (neg), type power_out | voltage (9 / 5) · voltage | spice V, logic const |
| vcc_symbol / gnd_symbol | 1:VCC / 1:GND, type power_out | vcc: voltage (5) · voltage | spice VSYM / GND, logic const |
| switch_spst | 1:1, 2:2 | state enum open closed (open) · state | spice SW, logic switch |
| button | 1:1, 2:2 | state enum released pressed (released) · state | spice SW, logic switch |
| buzzer | 1:+, 2:- | — | — |
| logic_probe | 1:IN, type input | — | logic probe |
| npn / pnp | 1:E, 2:B, 3:C (2N3904/2N3906 TO-92) | — | spice Q2N3904 / Q2N3906 |
| nmos | 1:S, 2:G, 3:D (2N7000 TO-92) | — | spice M2N7000 |
| 74hc00/02/04/08/32/86 | datasheet pin numbers; names `1A 1B 1Y … VCC GND` | — | logic `<id>` |
| 74hc74 | 1:1CLR 2:1D 3:1CLK 4:1PRE 5:1Q 6:1QN 7:GND 8:2QN 9:2Q 10:2PRE 11:2CLK 12:2D 13:2CLR 14:VCC (CLR/PRE active low) | — | logic 74hc74 |
| 74hc161 | 1:MR (CLR) 2:CP (CLK) 3–6:D0–D3 (A–D) 7:CEP (ENP) 8:GND 9:PE (LOAD) 10:CET (ENT) 11:Q3 (QD) 12:Q2 (QC) 13:Q1 (QB) 14:Q0 (QA) 15:TC (RCO) 16:VCC | — | logic 74hc161 |
| 74hc595 | 1:Q1 2:Q2 … 7:Q7 8:GND 9:Q7S (QH') 10:MR (SRCLR) 11:SHCP (SRCLK) 12:STCP (RCLK) 13:OE 14:DS (SER) 15:Q0 16:VCC | — | logic 74hc595 |
| ne555 | 1:GND 2:TRIG 3:OUT 4:RESET 5:CTRL (CONT) 6:THR 7:DIS 8:VCC | — | spice NE555 |
| lm358 | 1:1OUT 2:1IN- 3:1IN+ 4:GND (V-) 5:2IN+ 6:2IN- 7:2OUT 8:VCC (V+) | — | spice LM358 |

Logic sim semantics: `const` drives 1 when voltage ≥ 2 V, else 0 (`-`/GND pins drive 0); `switch` shorts its two nets when closed/pressed; `pull` (resistor) passes a **weak** copy of the value across, which loses to strong drivers; ICs output X unless VCC=1 and GND=0. Two strong drivers with different values → X.

## WP1 `@cadllm/dsl`: CNL parser and printer (tier: hard)
Implement FOUNDATION §3 exactly. Where the spec is ambiguous, pick the most token-cheap option and list it in the reply.

API:
```ts
parseCnl(text: string): CnlDoc                // whole file: header, meta, [sections]; syntax only, errors carry line numbers
applyEdit(tx: Tx, text: string): EditResult   // run CNL edit lines on a core Tx; collect ALL line errors, then throw CadErrors (prefix "line N: ")
printCircuit(q: Query, opts?: { select?: string[]; detail?: 0|1|2; place?: boolean }): string
printDelta(info: TxInfo, q: Query): string    // "ok rev=13 +R3 ~R1 nets: +LA ~VCC · merged N3 into LA"
loadCircuit(text: string, parts: PartResolver): Doc   // [circuit] (+ placement) → new Doc
saveCnl(doc: Doc): string                     // canonical file; loadCircuit(saveCnl(d)) round-trips exactly
```
- Component line `R1 res 330 key=val @bb:E10`: the positional value goes to `part.valueProp`. Values may be quoted (`"10k 1%"`). Spaces separate tokens; `;` also separates statements on one line.
- Net line `VCC: BAT1.+ R1.1` means connect. The edit prefixes are `-R1`, `-NET`, `-NET: pins`, `~R1 k=v` (and `k=` deletes a prop), and `mv A B`. `#` starts a comment.
- Printer: components first, then nets, in natural order, with columns aligned within each block. Pin labels come from `Query.pinLabel`. `detail=0` prints a one-line summary (`5 comps 4 nets · parts: res×2 led …`).
- `[tests]` section: parse into an AST only (`test "name"`, analysis line, `expect …` lines, `expect table` blocks). WP3/WP4 execute it.
- Golden tests: an `examples/*.cnl` round trip, error messages for bad lines, and printing of every delta shape.

## WP2 `@cadllm/library` + `parts/`: part library (tier: standard)
- **One JSON file per part:** `parts/<category>/<id>.json` matching `PartDef`. Generate the repetitive ones with a script in `packages/library/scripts/`, and commit the generated JSON.
- **API:** `loadLibrary(dirs: string[]): Library`, where `Library` implements `PartResolver` plus `search(q, limit)` → ranked `PartDef[]` and `summaryLine(p)` (e.g. `74hc00  quad 2-input NAND  14p DIP/SOIC  sim:logic`).
- **~40 parts:**
  - Passives and sources: res, cap, cap_pol, inductor, pot, led (a color prop), diode (1N4148), zener, battery, dc_supply.
  - Inputs and outputs: switch_spst, button, buzzer.
  - Transistors: npn (2N3904), pnp (2N3906), nmos (2N7000).
  - Logic: 74hc00/02/04/08/32/86, 74hc74, 74hc161, 74hc595.
  - Other ICs: ne555, lm358.
  - Probes and power symbols: gnd_symbol, vcc_symbol, logic_probe.
  - Boards: breadboard_half, breadboard_full, arduino_uno (pins only; MCU sim later).
- **Pinouts must match datasheets.** Set `datasheet` to the source URL for every IC and transistor.
- Pin `type`s must be set (inputs, outputs, `power_in` for VCC/GND), because ERC relies on them.
- `sim` refs: logic parts `{kind:'logic', ref:'<id>'}`; analog parts `{kind:'spice', ref:'<model>'}`.

## WP3 `@cadllm/sim-digital`: event-driven logic simulator (tier: hard)
- 4-state values (0, 1, X, Z), event queue, per-part propagation delay (default 10 ns), wired nets (multiple drivers → X unless all Z).
- Behavior models keyed by `sim.ref` for every WP2 logic part. Stimulus parts: switch/button (a `state` prop or a stimulus schedule) and battery/dc_supply/vcc/gnd as constant 1/0 (threshold: V ≥ 2 → 1).
- **API:**
  - `simulate(q, { until, stimulus? }) → Trace`
  - `truthTable(q, inputs: string[], outputs: string[]) → rows`
  - `formatTransitions(trace, probes)`: prints only the rows where something changes, aligned columns. Keep it token-cheap.
- Tests: every gate's truth table, the 74hc74 edge behavior, a 74hc161 counter counting, and an X on contention.

## WP4 `@cadllm/sim-analog`: DC operating point (tier: hardest)
- **Part 1, required:** our own Modified Nodal Analysis solver for the DC operating point.
  - Elements: R, voltage and current sources, battery, switches/buttons (as R_on/R_off), pots.
  - Nonlinear: diode, LED and zener via Shockley with Newton-Raphson, damping and gmin stepping.
  - Caps are open and inductors are shorts at DC.
  - API: `operatingPoint(q) → { v: Record<net, number>, i: Record<ref, number>, converged, iterations }`.
  - Clear errors for floating nets and singular matrices, naming the offending net.
- **Part 2, a spike (research only, no integration):** can ngspice run as WASM in Node 24? Find existing builds or packages, their licenses (they must be GPL-3-compatible), size, and how to run an `.op`/`.tran` netlist. Write the findings to `packages/sim-analog/NGSPICE-SPIKE.md` with a recommendation.
- Tests: dividers, a series LED current within 2% of hand calculation, a diode clamp, Newton convergence on reverse-biased cases.

## WP5 `engine`, `mcp`, `cli` (Claude, after WP1–2)
Sessions/projects (new/open/save/fork), the MCP tools from FOUNDATION §4.2 (M0 subset: project read edit find part check sim help history), stdio transport, and `cadllm mcp | test`. Then a benchmark: measure tokens per task for the two M0 goal circuits.

## Delegation (agy bridge)
WP1–WP4 run in parallel as agy sessions (disjoint folders) at the tiers above: standard = Hydrogen medium, hard = Hydrogen high, hardest = Hydrogen xhigh. Check `agy_usage` first. Review every diff and rerun `npm run check` before accepting.
