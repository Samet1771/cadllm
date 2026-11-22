# M0 Plan: Engine + MCP

Goal (from FOUNDATION §11): an agent builds **and verifies** an LED circuit and a 2-bit counter in ≤ 6 MCP calls, with no UI.

## Status

| Package | State |
|---|---|
| `core` | ✅ Done: types, Query, Tx (transactions), Doc (revisions, undo/redo, `since`), `basicChecks`, `parseSI`. 33 tests. |
| `dsl` | ⏳ WP1 |
| `library` + `parts/` | ⏳ WP2 |
| `sim-digital` | ⏳ WP3 |
| `sim-analog` | ⏳ WP4 |
| `engine`, `mcp`, `cli` | ⏳ WP5 (after WP1–2) |

## Ground rules for every work package
- **Read first:** `docs/FOUNDATION.md` (especially §3 CNL and §4 MCP), `packages/core/src/*.ts` (the contract), `packages/core/test/doc.test.ts` (style).
- **Own only your package folder** (plus `parts/` for WP2). Don't edit `core`. If core needs a change, say so in the reply instead.
- **TypeScript runs natively on Node 24.** Erasable syntax only: no `enum`, `namespace` or constructor parameter properties. Imports use `.ts` extensions. Packages export `./src/index.ts` and are named `@cadllm/<pkg>`. Every source file starts with the SPDX header used in core.
- **No new runtime dependencies** without saying why (dev dependencies for tests are fine).
- **Deterministic output** everywhere: sorted, stable, no timestamps or randomness.
- **Done when:** `npm run check` passes at the repo root, and the reply lists the files changed, the public API and any open questions.

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
