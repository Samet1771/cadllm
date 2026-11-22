# M2 Plan: Sim++ (ngspice, avr8js, mixed-signal, live UI)

Goal (FOUNDATION §11): **an Arduino blink + button simulation matches Tinkercad behavior** (LED on D13 toggles every 1 s; a button with pull-down on D2 read by `digitalRead` turns an LED on while pressed), runnable headless by an AI over MCP and visible in the UI.

## Decisions (recorded in WP0)
1. **Arduino compilation:** local `arduino-cli` (`C:\Program Files\Arduino CLI\arduino-cli.exe`, v1.6.0, core `arduino:avr@1.8.8`; `arduino-cli compile --fqbn arduino:avr:uno --output-dir <dir> <sketchdir>` produces `<name>.ino.hex`). Resolution order: `CADLLM_ARDUINO_CLI` env → `arduino-cli` on `PATH` → `C:\Program Files\Arduino CLI\arduino-cli.exe`. Missing binary → clear `CadError` with install instructions. Compiled hex cached by `sha256(source + fqbn)` under `~/.cadllm/build/` (override `CADLLM_STATE_DIR`).
2. **Firmware storage:** lives in the single `.cnl` file as `[code <ref>]` holding raw sketch text verbatim until the next section header line matching `^\[(circuit|breadboard|schematic|pcb|tests|code\s+\S+)\]\s*$`. Stored in circuit meta under `__code:<ref>` (hidden like `__tests`). Round-trips verbatim via `loadCircuit`/`saveCnl`. `mv U1 U2` moves `__code:U1` → `__code:U2`; `-U1` deletes it.
3. **MCP `edit` / `read`:** `edit` gains `code: { ref: string; text: string }` (`""` deletes); `read` gains `code: string` (a ref) to print that sketch. No new top-level tools.
4. **Mixed-signal model:** event-driven co-simulation. MCU (`avr8js`, cycle-accurate at 16 MHz) + 4-state digital sim + analog solved **quasi-statically** (DC operating point via `@cadllm/sim-analog`) whenever any digital level changes. Covers blink, button, and LED brightness. Full SPICE transient (`ngspice`) is for analog-only circuits (RC, filters, transistors, 555, op-amps) — no mixed ngspice transient in M2.
5. **ngspice engine:** WP1 spike-tests `@o.z/ngspice-wasm` (BSD-3, ~6.9 MB unpacked) first and `eecircuit-engine` (MIT, ~41.1 MB unpacked) second in real Node 24, keeping the first that runs `.op`/`.tran`/`.ac` headless behind `@cadllm/sim-spice`. Our own MNA solver (`@cadllm/sim-analog`) stays the `dc`/`op` engine (fast, exact errors); ngspice serves `tran` and `ac`, and `op` only when a part has no own-solver model (`npn`, `pnp`, `nmos`, `ne555`, `lm358`).
6. **UI code editor:** CodeMirror 6 (`codemirror` + `@codemirror/lang-cpp`), not Monaco.

## Status

| Piece | State | Summary |
|---|---|---|
| WP0 contracts, `[code]` DSL, test AST, `arduino_uno` sim ref, examples, deps, `M2-PLAN.md` | ✅ | |
| WP1 `@cadllm/sim-spice` (ngspice WASM spike, netlist, `op`/`tran`/`ac`) | ✅ | `eecircuit-engine` chosen; `@o.z/ngspice-wasm` was unusable — only CLI `_main`, a second run aborts — and has been uninstalled; ~190 ms cold start, warm runs 3–25 ms; RC/AC/555/LED accuracy tests. |
| WP2 `@cadllm/sim-mcu` (`compileSketch` + `Uno` avr8js wrapper) | ✅ | `arduino-cli` compile ~1 s cold / <1 ms cached; `avr8js` Uno; 4 simulated s ≈ 0.7 s wall. |
| WP3 `@cadllm/sim-mixed` + engine/test evaluation + MCP summaries + examples passing | ✅ | Event-driven co-sim; `run`/`tran`/`ac`; 11 measures; `blink` and `button-led` examples pass end to end. |
| WP4 `@cadllm/ui` code editor + run controls + `@cadllm/views` live state rendering | ✅ | CodeMirror editor, run bar, real-time playback, LED glow/net coloring in both views. |

## Measured

`npm run bench`:
```
tools 11 · schema ≈1145 tok
PASS led: 5V LED, prove I < 20 mA                                calls 5  in ≈84  out ≈56  total ≈140 tok
PASS counter: 2-bit counter, verify sequence                     calls 4  in ≈138  out ≈141  total ≈279 tok
PASS layout: place the LED circuit on both views and look at it  calls 4  in ≈68  out ≈53  total ≈121 tok  img ≈256
PASS blink: write the sketch, run it, verify the period          calls 2  in ≈93  out ≈48  total ≈141 tok
```

Verified MCP transcript summary:
- Blink 500 ms sketch → `period(D13) 1`, `duty 50%`, `max(I(D1)) 11.2m`, serial `hi`.
- RC 1k/1µ `tran 5m` → `V(OUT)@1m` `3.16` (analytic `3.16`), `ac` −3 dB `160 Hz` (analytic `159 Hz`).

Open items (post-M2):
- Mixed MCU + ngspice transient (M2 analog is quasi-static DC in mixed runs).
- `?demo` UI mode not running view checks.
- Schematic per-gate IC units.
- Manual wire waypoints.

## Ground rules (in addition to M0/M1)
- **Read first:** `docs/FOUNDATION.md` (§3, §4, §11), this file, and the WP0 contracts (`packages/sim-spice/src/index.ts`, `packages/sim-mcu/src/index.ts`, `packages/sim-mixed/src/index.ts`, `packages/views/src/types.ts`, `packages/dsl/src/ast.ts`).
- **Own only your folder:**
  - **WP1:** `packages/sim-spice/`
  - **WP2:** `packages/sim-mcu/`
  - **WP3:** `packages/sim-mixed/`, `packages/engine/src/sim.ts` + engine tests, `examples/` (plus making `Engine.sim`/`Engine.test`, `mcp/src/server.ts` `reply`, `server/src/ws.ts` `callTool`, and `cli/src/main.ts` async when wiring `tran`/`ac`/`compileSketch`)
  - **WP4:** `packages/ui/` and `packages/views/src/{sch,bb}/state*.ts` + their tests (WP4 may make minimal hook edits in `packages/views/src/{sch,bb}/render.ts` to call into `state*.ts`)
- **Don't run `npm install`.** All M2 dependencies are already installed (`@o.z/ngspice-wasm`, `eecircuit-engine`, `avr8js`, `codemirror`, `@codemirror/lang-cpp`).
- **Node 24 erasable TypeScript:** no `enum`, `namespace`, or constructor parameter properties; `.ts` import extensions; SPDX header on every new source file.
- **Deterministic output:** sorted keys, stable formatting, no wall-clock timestamps or randomness in simulation outputs.
- **Done when:** `npm run check` passes at the repo root (WP4: plus `npm run typecheck -w @cadllm/ui` and `npm run build -w @cadllm/ui`).

## Shared conventions
- **Time units:** seconds everywhere in APIs and AST (`1s` = `1`, `10ms` = `0.01`, `1us` = `1e-6`).
- **SI formatting:** format scalar results with `formatSI` from `@cadllm/sim-analog` (token-cheap, `parseSI`-compatible).
- **Probe names:**
  - Analog voltage: `V(NET)` or `V(REF.PIN)`
  - Analog current: `I(REF)`
  - Digital / mixed net: net name or `REF.PIN` (e.g. `D13` = net on `U1.D13`, or `U1.D13`)
- **Firmware:** stored in circuit meta `__code:<ref>`, serialized as `[code <ref>]`, edited via `edit({ code: { ref, text } })`, read via `read({ code: ref })`.

## WP1 `packages/sim-spice`: ngspice-WASM adapter (tier: hardest)
**First step — real Node 24 spike:** test `@o.z/ngspice-wasm` first and `eecircuit-engine` second directly in Node 24 ESM for `.op`, `.tran`, and `.ac` (including reading real + complex AC vectors and stdout/error logs). Pick the first package that works cleanly headless without browser shims, and hide the choice behind `@cadllm/sim-spice`. Reuse the single WASM instance safely across calls (reset/destroy plots between runs so repeated calls do not leak or corrupt state).

**`toSpiceNetlist(q, opts?)`:**
- Ground reference follows `sim-analog` convention (`gnd_symbol`, `GND` net, or `-` pin of first V source → SPICE node `0`).
- Emit all basic parts (`R`, `C`, `L`, `POT`, `V`, `VSYM`, `GND`, `SW`, `D1N4148`, `DZ`, `LED`) plus `.model` / `.subckt` definitions for `npn` (`Q2N3904`), `pnp` (`Q2N3906`), `nmos` (`M2N7000`), `ne555` (`NE555`), and `lm358` (`LM358`) using standard datasheet-aligned parameters/macro-models.
- Include `.op`, `.tran <step> <stop>`, or `.ac <sweep> <points> <start> <stop>` plus `.end`.

**`runSpice(netlist, analysis)`, `tran(q, opts)`, `ac(q, opts)`, `op(q, opts)`:**
- Return `SpiceResult`: `{ vectors, scale: { name: 'time'|'frequency', values }, complex?, log }`.
- Map SPICE node voltages `v(<node>)` and source currents `i(<vsource>)` back to CadLLM net names and component refs (add 0 V sensing sources where component current probes are requested if needed).
- Surface clear `CadError` on netlist/convergence/WASM errors.

**Tests:** RC step response (`.tran` reaches `1 - 1/e` at `t = RC`), RC low-pass filter `-3 dB` cutoff (`f = 1/(2πRC)`) via `.ac`, 2N3904 NPN common-emitter/switch `.op` + `.tran`, NE555 astable oscillator `.tran`, LM358 non-inverting amplifier `.op`/`.ac`.

## WP2 `packages/sim-mcu`: Arduino compiler + avr8js runner (tier: hard)
**`compileSketch(text, { fqbn? })`:**
- Default `fqbn`: `'arduino:avr:uno'`.
- Resolve `arduino-cli`: `process.env.CADLLM_ARDUINO_CLI` → `arduino-cli` on `PATH` → `C:\Program Files\Arduino CLI\arduino-cli.exe`. Missing executable → `CadError` with clear install instructions and checked locations.
- Cache key: `sha256(fqbn + '\0' + text)` stored under `join(process.env.CADLLM_STATE_DIR ?? join(homedir(), '.cadllm'), 'build', <hash> + '.hex')` (plus optional `.meta.json` or `.size`). Return `{ hex, size, cached, log }`.
- Compile in a temp dir (`<tmp>/sketch/sketch.ino`) with `arduino-cli compile --fqbn <fqbn> --output-dir <tmp>/out <tmp>/sketch`, read `<sketch>.ino.hex`, surface compiler errors with line info on non-zero exit.

**`class Uno` (`avr8js`, 16 MHz ATmega328P):**
- Parse Intel HEX into flash memory (`Uint8Array` / `Uint16Array`).
- Wire `AVRIOPort` (`portB`, `portC`, `portD`), `AVRTimer` (`timer0`, `timer1`, `timer2` — required for `delay()`, `millis()`, `micros()`, `analogWrite()`), `AVRUSART` (`usart0` → `serial` string capture), and `AVRADC` (`adc` → analog channel voltages from `setInput(pin, volts)`).
- Pin mapping: `D0..D7` = `PD0..PD7`, `D8..D13` = `PB0..PB5`, `A0..A5` = `PC0..PC5` (and ADC0..5).
- `pin(name)` returns `{ mode: 'input'|'output'|'input_pullup', level: '0'|'1'|'X'|'Z' }` derived from DDR/PORT/PIN registers.
- `setInput(name, level)`: `'0'|'1'|'X'|'Z'` sets digital input pin state; `number` (volts, `0..5`) sets ADC channel voltage AND digital threshold (`>= 2.5` → `'1'`, else `'0'`).
- `run(seconds, onPinChange?)`: advance CPU by `Math.round(seconds * 16_000_000)` cycles; fire `onPinChange(t, pin, level)` at exact cycle time `t = baseTime + cycle / 16_000_000` whenever any pin's mode/driven output level changes. Keep `time` updated.

**Tests:** compile + run real Blink sketch (if `arduino-cli` present; also unit-test Intel HEX + `Uno` with a prebuilt/minimal blink hex or mock/cached fixture so tests work fast and deterministically), `Serial.println` capture, `digitalRead` + `digitalWrite`, `analogRead` / PWM (`analogWrite`), missing `arduino-cli` error message, SHA-256 build cache hit on second compile.

## WP3 `packages/sim-mixed` + Engine + Examples (tier: hard)
**`runMixed(q, { until, stimulus?, probes, firmware })`:**
- Instantiate `Uno` for each component with `sim.kind === 'mcu'` using `firmware[comp.ref]`.
- Bridge MCU pins ↔ circuit nets, 4-state digital gates/switches/pulls (`@cadllm/sim-digital`), and quasi-static analog DC (`operatingPoint` from `@cadllm/sim-analog` using settled net logic levels whenever digital levels change or analog-only events occur).
- Advance in event steps (MCU pin-change callbacks + `stimulus` switch/button presses/releases) up to `until` seconds:
  - Feed circuit net logic/voltage levels into MCU `input`/`input_pullup` pins (`Uno.setInput`).
  - Propagate MCU `output` pins (`Uno.pin` changes) into digital nets (respecting pull-ups/pull-downs and switch states), re-solving digital + quasi-static analog DC on each change.
  - Record `changes` (`{ t, net, v }`), `analog` samples (`{ t, values }` for requested `V(...)`/`I(...)` probes), `serial`, and `warnings`.
- `formatMixed(trace, probes)`: aligned transition table like `sim-digital`'s `formatTransitions`, showing analog probes formatted with `formatSI` and digital probes as `0`/`1`/`X`/`Z`, capped at ~40 rows with `… N more` footer.

**Engine test evaluation & MCP summaries (`packages/engine/src/sim.ts`, `engine.ts`, `mcp/server.ts`, `server/ws.ts`, `cli/src/main.ts`):**
- Make `Engine.sim`, `Engine.test`, `runAnalysis`, `runAdhoc`, `runFileTests` async (`Promise<...>`), and await them in `mcp/server.ts`, `server/ws.ts`, `cli/src/main.ts`, and `engine.test.ts`.
- Route `tran` / `ac` (and `op`/`dc` fallback when a circuit contains `npn`/`pnp`/`nmos`/`ne555`/`lm358`) to `@cadllm/sim-spice`.
- Route `run <duration> [press=SW1@0.5s-1.2s,...] [probes=]` to compile `[code <ref>]` via `compileSketch` and run `runMixed`.
- Evaluate all new `expect` measures (`at` via `@<t>`, `min`, `max`, `avg`, `final`, `rms`, `freq`, `period`, `duty` as 0..1 matching `%`, `rise` 10-90%, `fall` 90-10%) across `tran`, `ac`, and `run` results.
- Produce compact token-cheap summaries (per FOUNDATION §4.3: one line per probed measure or compact transition table) and update `help topic=sim` / `help topic=tests`.
- **Done-when verification:** both `examples/blink.cnl` and `examples/button-led.cnl` pass `cadllm test`!

## WP4 `packages/ui` + `packages/views` live state (tier: hard)
**Views live state (`packages/views/src/{sch,bb}/state*.ts` + minimal hooks in `render.ts`):**
- Consume `RenderOptions.state?: { nets?: Record<string, '0'|'1'|'X'|'Z'|number>; parts?: Record<string, { on?: boolean; level?: number }> }`.
- Color nets/wires/jumpers by state (`1`/HIGH = warm red/orange, `0`/LOW = cool blue/slate, `X` = magenta/amber, `Z` = neutral; analog voltage mapped smoothly).
- Draw lit LEDs (bright halo/glow scaled by `level ?? (on ? 1 : 0)`) and pressed buttons (`on === true` depressed actuator visual) in both schematic and breadboard SVGs.
- Deterministic SVG output; unit tests for LED glow, button press, and net coloring in both views.

**UI (`packages/ui/`):**
- CodeMirror 6 (`codemirror` + `@codemirror/lang-cpp`) sketch editor panel when an MCU component (e.g. `arduino_uno`) is selected or present; reads/saves via `read { code: ref }` and `edit { code: { ref, text } }`.
- Simulation run controls: duration, button press toggles / interactive click-to-press during or before run, Run button calling `sim`, timeline/scrubber over returned trace or live state, Serial monitor output pane, and passing `RenderOptions.state` into `views.render`.
- Keep `npm run typecheck -w @cadllm/ui` and `npm run build -w @cadllm/ui` green, plus unit tests for pure UI helpers.
