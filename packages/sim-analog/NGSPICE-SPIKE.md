# ngspice-WASM in Node 24 — Research Spike

> Research only (no packages installed, no live runtime execution). All registry numbers come from `npm view` on 2026-11-22; API/build behavior comes from package READMEs and public repository metadata.

## Verdict

Yes: ngspice compiled to WebAssembly via Emscripten can run headlessly in Node 24 without native toolchains, provided the build avoids browser-only `fetch()`/Web Worker assumptions (or supports passing a WASM buffer / Node `fs`). Between existing npm packages, **`eecircuit-engine`** has the strongest maintenance and highest-level TypeScript API (at ~43 MB unpacked, with Node compatibility needing sandbox verification), while **`@o.z/ngspice-wasm`** is much smaller (~7.3 MB unpacked) and explicitly targets Node ESM/CJS under `BSD-3-Clause`, though it is early (`0.0.0`) and low-level.

## Candidates

| Candidate | Engine / Origin | Version | License (GPL-3 compat?) | Unpacked Size | Maintenance | Node Support |
|---|---|---|---|---|---|---|
| [`eecircuit-engine`](https://www.npmjs.com/package/eecircuit-engine) | Emscripten ngspice (Asyncify) | `1.9.0` | `MIT` (✅ Yes; verify bundled upstream ngspice `COPYING`) | `43.1 MB` (18 files, 0 npm deps) | Active (`danchitnis`, weekly `-next`, updated 2026-11-21) | Mixed signals: web-first (Web Worker / Vite); Node use cited, **unverified without shims** |
| [`@o.z/ngspice-wasm`](https://www.npmjs.com/package/@o.z/ngspice-wasm) | Emscripten `ngspice-46` (`MODULARIZE`, `EXPORT_ALL=1`) | `0.0.0` | `BSD-3-Clause` (✅ Yes; ships `COPYING` for ngspice mixed licenses) | `7.27 MB` (6 files, 0 npm deps) | Single release (`z-wasm`, updated 2026-05-27) | Explicit in README: `engines.node >= 18`, ESM & CJS + `ngspice.d.ts` |
| [`wokwi/ngspice-wasm`](https://github.com/wokwi/ngspice-wasm) | Emscripten ngspice (GitHub repo, not on npm) | git | `MIT` (✅ Yes; upstream ngspice BSD) | N/A (not on npm) | Community / Wokwi repo | Reported browser + Node; requires building or vendoring |
| [`@tscircuit/ngspice-spice-engine`](https://www.npmjs.com/package/@tscircuit/ngspice-spice-engine) | Wrapper adapting ngspice to `tscircuit` `circuit-json` | `0.0.25` | `MIT` (✅ Yes) | `47.8 kB` (5 files) | Active (`seveibar`, updated 2026-11-19) | Built for `bun test` / `tscircuit`; coupled to `circuit-json` schema |
| [`@strategicprojects/dune-sim`](https://www.npmjs.com/package/@strategicprojects/dune-sim) | **Not ngspice**: Rust port of SPICE3f5 + ngspice-47 device models (`wasm-pack`) | `0.12.1` | `BSD-3-Clause AND ECL-2.0` (⚠️ Check `ECL-2.0` notice/patent terms) | `3.70 MB` (10 files, 0 npm deps) | Active (`milkway/dune`, updated 2026-11-15) | Explicit: Node supported via `ready(fs.readFileSync(...))` |
| [`spicey`](https://www.npmjs.com/package/spicey) | Pure JS SPICE alternative (not ngspice) | `0.0.14` | ⚠️ **No `license` field** in npm metadata | `46.6 kB` (5 files) | `seveibar` (updated 2025-11-16) | Pure JS; not upstream ngspice |

## Licensing Notes (GPL-3.0 Compatibility)

- **Upstream ngspice** uses a mixed permissive/weak-copyleft model (documented in `@o.z/ngspice-wasm` README): Spice3f5 (`BSD-3-Clause`), CIDER (historical Berkeley BSD notice — UC Berkeley rescinded the 4-clause advertising clause in 1999, making current distributions GPL-compatible), XSPICE (Public Domain), KLU/numparam (`LGPL-2.1`), and OSDI (`MPL-2.0`). All of these are compatible with CadLLM's `GPL-3.0-or-later` license when `COPYING` notices are preserved.
- **`eecircuit-engine` (`MIT`)** and **`@o.z/ngspice-wasm` (`BSD-3-Clause`)** are GPL-3-compatible.
- **`@strategicprojects/dune-sim`** combines `BSD-3-Clause` with `ECL-2.0` (Educational Community License 2.0, an Apache-2.0 variant compatible with GPLv3 but requiring patent/notice review before adoption).
- **`spicey`** lacks a `license` field in npm metadata and is disqualified until clarified (also not ngspice).

## Running `.op` / `.tran` and Reading Vectors (API Sketch)

### Pattern A — High-level wrapper (`eecircuit-engine`)

```ts
import { Simulation } from 'eecircuit-engine';

const sim = new Simulation();
await sim.start(); // loads spice.wasm (Asyncify)
sim.setNetList(`
LED circuit
V1 vcc 0 DC 5
R1 vcc la 220
D1 la 0 DLED
.model DLED D(Is=7.38e-16 N=2.5)
.op
* or: .tran 10u 10m
.end
`);
const result = await sim.runSim(); // returns parsed variables/data vectors + stdout/errors
```

### Pattern B — Low-level Emscripten module (`@o.z/ngspice-wasm` / custom `--with-ngshared`)

Two invocation modes exist depending on whether the Emscripten build links CLI `main()` or shared `libngspice`:

1. **Batch CLI via MEMFS + `_main` (or `wrdata` / stdout parsing):**
   - Pass `{ noInitialRun: true, print: line => ..., printErr: ... }` to `createNgspiceModule()`.
   - `ngspice.FS.writeFile('/circuit.cir', netlist + '\n.control\nop\nprint all\n* or tran 10u 10m; wrdata /out.txt v(la) i(v1)\n.endc\n.end\n')`.
   - Call `_main` with `['ngspice', '-b', '/circuit.cir']` or read `/out.txt` back with `ngspice.FS.readFile('/out.txt', { encoding: 'utf8' })`.
2. **Shared-library C API (`ngSpice_Init`, `ngSpice_Command`, `ngSpice_AllPlots`, `ngSpice_AllVecs`, `ngGet_Vec_Info`):**
   - Load netlist lines via `ngSpice_Circ` or `ngSpice_Command('source /circuit.cir')`, then `ngSpice_Command('bg_run')` / `'run'`.
   - Read plot name from `ngSpice_AllPlots()`, vector names from `ngSpice_AllVecs(plot)`, and `vector_info` struct pointers via `ngGet_Vec_Info(`${plot}.${vec}`)` to slice `Float64Array(HEAPF64.buffer, vRealPtr, vLength)`.

## Risks

1. **Package bloat vs. low-level maintenance:** `eecircuit-engine` is ~43.1 MB unpacked (heavy for CLI/MCP distribution and CI installs), whereas `@o.z/ngspice-wasm` is `v0.0.0` (single release, low-level C pointer ABI).
2. **Node 24 WASM loading quirks:** Emscripten bundles compiled for web/workers sometimes call `fetch()` on relative `.wasm` URLs or assume `self`/`WorkerGlobalScope`; Node requires `ENVIRONMENT=node,web` (or `locateFile` + `fs.readFile` / `wasmBinary`).
3. **Single-instance / reentrancy state:** Upstream `ngspice` has extensive C global state (`ft_curckt`, plot lists). In a single WASM instance, running concurrent simulations requires either resetting/freeing plots (`destroy all` / `remcirc`) between runs or isolating each run in a Node `worker_threads` worker / fresh module instantiation.
4. **ABI fragility on `ngGet_Vec_Info`:** Reading `vector_info` directly from `HEAP32`/`HEAPF64` hardcodes WASM32 struct field offsets and padding across ngspice versions unless wrapped in a small C helper or replaced by `wrdata` text/binary rawfile parsing.
5. **WASM feature limits:** No `dlopen()` for external XSPICE `.cm` code models, no pthreads without SharedArrayBuffer/worker flags, and finite initial memory (`256 MB` default in `@o.z/ngspice-wasm`, growth enabled).

## Recommendation

1. **Keep `@cadllm/sim-analog`'s pure-TS MNA solver as the M0/M1 DC operating-point engine** — it has zero dependencies, < 1 ms startup, deterministic behavior, exact CadLLM error reporting, and works identically in Node 24 and browsers.
2. **For M2 (`.tran`, `.ac`, BJT/MOSFET/op-amp `.model`/`.subckt`):** start by testing **`eecircuit-engine`** (MIT, actively maintained) in an isolated Node 24 spike to measure actual Node startup without browser shims and inspect its exact `.wasm` payload; if `43 MB` or worker/fetch assumptions block headless Node use, fall back to a **tiny in-house Emscripten build** (using `z-wasm/ngspice-wasm`'s reproducible `builder.sh` pattern with `--with-ngshared` + `MODULARIZE=1` + `-O3` + stripped symbols, expected ~4–8 MB) inside a `worker_threads` / Web Worker wrapper.
3. **Do not adopt `spicey` (missing license, non-ngspice)** or **`@tscircuit/ngspice-spice-engine` (`circuit-json` coupling)**; keep `@strategicprojects/dune-sim` only as a secondary reference if a pure-Rust SPICE3f5 WASM core is preferred over C/Emscripten ngspice.

## Unverified (Not Tested Live — No Install Allowed)

- Whether `eecircuit-engine@1.9.0` starts cleanly in Node 24 ESM (`new Simulation(); await sim.start()`) without `fetch`/Web Worker polyfills, and the exact TypeScript shape of its `runSim()` result object.
- Actual compressed tarball size vs. `.wasm`-only size inside `eecircuit-engine` (`43.1 MB` unpacked) and `@o.z/ngspice-wasm` (`7.27 MB` unpacked).
- Whether `@o.z/ngspice-wasm@0.0.0` exports `ngSpice_AllPlots` / `ngSpice_AllVecs` / `ngGet_Vec_Info` (shared-library mode) or only CLI `_main` / `_ngSpice_Command`, and whether `ngspice._main` can be called repeatedly without re-instantiating the WASM module.
- Exact `vector_info` WASM32 byte offsets for `ngspice-46`.
- Cold-start instantiation latency and memory footprint in Node 24 under Vitest / MCP stdio.
