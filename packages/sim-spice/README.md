# `@cadllm/sim-spice`

Headless ngspice-WASM adapter for `.op`, `.tran`, and `.ac` circuit simulation in Node 24.

## Node 24 Engine Spike Results

Both pre-installed ngspice WebAssembly packages were benchmarked and tested live in plain Node 24 (`v24.19.0`) ESM with zero browser shims:

| Package | Version | ngspice | Startup | Per-run (`.op`/`.tran`/`.ac`) | Re-run in same instance | Selected |
|---|---|---|---|---|---|---|
| `@o.z/ngspice-wasm` | `0.0.0` | `ngspice-46` | ~19 ms | ~14 ms (`.op` only with `/proc/meminfo` shim) | **Fails:** 2nd `_main()` aborts with `main: Internal Error: jump to zero` (`exit(1)`) | No |
| `eecircuit-engine` | `1.9.0` | `ngspice-45.2` | ~187 ms | ~0.5–14 ms (`.op`), ~4.5 ms (`.tran`), ~3 ms (`.ac`) | **Works cleanly:** `remcirc` + `destroy all` between runs, deterministic, recovers after errors | **Yes** |

### Findings

1. **`@o.z/ngspice-wasm`:**
   - Only exports Emscripten CLI `_main` and `FS` (no `ngSpice_Command` / `libngspice` shared-library exports).
   - Fails on the first run unless `/proc/meminfo` is synthesized in Emscripten `MEMFS` (`fopen("/proc/meminfo"): No such file or directory`, `Setting the output memory is not possible.`).
   - Calling `_main` a second time on the same WASM instance immediately aborts with `main: Internal Error: jump to zero` (`ExitStatus(1)`), making single-instance reuse across simulations impossible without re-instantiating the WASM module on every run.

2. **`eecircuit-engine` (`Simulation` API):**
   - Instantiates an Asyncify-compiled ngspice-45.2 WASM bundle directly in Node ESM (`new Simulation(); await sim.start()`), with `sim.setNetList(netlist)` and `await sim.runSim()` returning parsed real (`RealDataType[]`) and complex (`ComplexDataType[]`) vectors plus `sim.getInfo()` and `sim.getError()`.
   - Reuses a single WASM instance safely by executing `source test.cir` -> `remcirc` -> `destroy all` -> `run` -> `write out.raw` across sequential runs.
   - Wrapper safeguards added in `src/runner.ts`:
     - Serialized async execution queue (`serialize`) because `Simulation` has single-instance mutable state.
     - Fatal error detection (`FATAL_RE` + empty output check) so failed runs throw `CadError` instead of returning stale `/out.raw` contents from a prior run.
     - Log normalization strips incrementing `ngspice N ->` prompt prefixes and wall-clock `Date:` header lines so outputs remain 100% deterministic across runs.

## Supported Parts & Models

- Passives & Sources: `R`, `POT`, `C`, `L`, `V`, `VSYM`, `GND`, `SW` (`switch_spst`, `button`), `D1N4148`, `DZ` (Zener), `LED` (red, yellow, green, blue, white — reusing `@cadllm/sim-analog` parameters).
- Semiconductors & ICs: `npn` (`Q2N3904`), `pnp` (`Q2N3906`), `nmos` (`M2N7000`), `ne555` (`NE555` subcircuit), `lm358` (`LM358` dual op-amp subcircuit).
- Logic ICs (`74hc*`) throw a clear `CadError` naming the part (use `@cadllm/sim-digital` or `@cadllm/sim-analog` for M2).
