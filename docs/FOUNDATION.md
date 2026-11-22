# CadLLM — Foundation Design

> Status: **draft v0.1** (2026-11-22). Working name "CadLLM" — rename before going public.
> Scope: the decisions everything else is built on. Anything marked **[OPEN]** needs a call before code depends on it.

---

## 1. What we are building

An open-source (GPL) electronics workbench that covers the Fritzing / Tinkercad Circuits / KiCad space:

| View | Like | Purpose |
|---|---|---|
| **Breadboard** | Tinkercad, Fritzing | Physical prototyping on breadboards, beginners, teaching |
| **Schematic** | KiCad Eeschema | Logical design, readable documentation |
| **PCB** | KiCad Pcbnew, Fritzing PCB | Footprints, traces, Gerber export |
| **Simulation** | Tinkercad, LTspice, Logisim | Digital logic, analog (SPICE), microcontrollers |

What makes it different: **AI-first**. An AI agent driving it over MCP is the primary user we design for, and the human UI is the second client of the same API. If an AI can't do it cheaply over MCP, the feature isn't done.

### Principles (ranked; earlier wins when they conflict)

1. **One API, many clients.** UI, MCP, CLI and plugins all call the same engine operations. Nothing is possible only from the UI.
2. **Token-cheap by construction.** Compact text in and out, short stable IDs, deltas not dumps, summaries not raw data, terse by default with detail on request.
3. **Headless first.** The engine runs without a UI, so AI can build, simulate and test circuits with no browser open.
4. **Deterministic and testable.** The same input gives the same file, the same simulation and the same output. Circuits can carry tests (`expect`) that run in CI.
5. **Text is the source of truth.** The project file is human- and AI-readable, git-diffable text, and it uses the same grammar the MCP speaks.
6. **Extensible from day one.** Built-in parts, models and tools use the same plugin contracts a third party would use.
7. **Local first.** No account, no cloud. A web page and plugin store come later and must not need architecture changes.

---

## 2. Core concept: one netlist, many views

This decision shapes the rest of the design.

```
                 ┌──────────────────────────────┐
                 │   CIRCUIT (canonical)        │
                 │   components + nets + props  │   ← AI works here
                 └──────────────┬───────────────┘
        ┌───────────────┬───────┴───────┬────────────────┐
   Breadboard        Schematic         PCB            Simulation
   placement in      symbol pos,       footprint pos,  derived from
   holes, wires      wires, labels     traces, zones   netlist + models
```

- The **netlist is canonical**: which pins connect to which.
- Each **view is a realization** of it with its own geometry. A view can be:
  - *complete*: every net is physically realized,
  - *partial*: some connections are only a **ratsnest** (unrouted), or
  - *conflicting*: the view has a short or connection that isn't in the netlist. It gets flagged, never silently merged.
- **Edit flow is two-way:** plugging a wire into a breadboard in the UI produces a netlist edit, and an AI netlist edit produces ratsnest lines in every view (plus optional auto-placement and auto-wiring).
- **Geometry is optional** for AI. A circuit with no coordinates is valid; the auto-layout tools place it. AI should never be forced to compute pixel coordinates.

This is Fritzing's model, made explicit and with the netlist as primary rather than the breadboard.

---

## 3. The circuit language (CNL)

One compact text grammar used for **the project file, MCP reads, MCP edits, and tests**. Learn it once and it applies everywhere. Token cost was the main design constraint.

### 3.1 Reading a circuit

```
# button -> NAND gate -> LED
BAT1 battery 5V
D1   led red
R1   res 330
R2   res 10k
SW1  button
U1   74hc00

VCC: BAT1.+ U1.VCC U1.1A SW1.1
IN:  SW1.2 U1.1B R2.1
GND: BAT1.- U1.GND D1.K R2.2
Y:   U1.1Y R1.1
LA:  R1.2 D1.A
```

- **Component line:** `<ref> <part> [value] [key=val …] [@view:pos]`
- **Net line:** `<NET>: <pin> <pin> …`
- **Pin refs:** `REF.PIN`, where PIN is a number or name (`U1.1`, `U1.VCC`, `D1.A`). Names come from the part definition, and aliases are allowed (`D1.A` = `D1.anode` = `D1.1`).
- **Refs** follow EE convention (`R1`, `U3`, `J2`). They are short, meaningful and stable, and replace UUIDs entirely in the AI surface. Internally each object also has an immutable id, so renaming `R1→R10` is safe.
- Auto-named nets are `N1`, `N2`, …. Named nets (`VCC`, `GND`) are preferred and power nets are recognized.
- **Order is canonical** (refs sorted naturally, nets by name), so output is deterministic and diff-friendly.

### 3.2 Placement (optional)

```
U1 74hc00 @bb:E10          # breadboard: pin 1 in hole E10
R1 res 330 @bb:F20-F24     # spans holes
U1 @sch:40,20              # schematic grid units
U1 @pcb:12.7,8.0,90 top    # mm, rotation, side
```

Breadboard positions use **hole names**, not pixels. That costs few tokens, matches how people talk about breadboards, and an LLM can reason with it.

### 3.3 Editing (the same grammar plus 3 prefixes)

```
R3 res 1k            # upsert component (add, or change part/value/props)
~R1 value=470        # modify props only
-R2                  # remove component (its pins leave their nets)
LA: D2.A             # connect: ADD pins to a net (creates the net if new)
-LA: R1.2            # disconnect pin(s) from a net
-LA                  # delete net
mv R3 R4             # rename ref or net (merging nets: mv N4 VCC)
```

- An edit batch is **one atomic transaction**: all lines apply or none do. It produces one undo step and one revision.
- Errors point at the line and suggest fixes:
  `E line 3: U1 has no pin VDD. pins: 1A 1B 1Y 2A … GND VCC`
- `dry_run` validates and returns the delta without applying it.

### 3.4 Tests in the same file

```
test "nand truth table"
  logic in=SW1 out=U1.1Y
  expect table
    0 -> 1
    1 -> 0

test "led current"
  dc
  expect I(D1) 8m..15m
  expect V(LA) > 1.8
```

`cadllm test project.cnl` runs these headless, and MCP `sim` can run them. **Circuits get unit tests**, and an AI can check its own work in one call.

### 3.5 Project file

`*.cnl` text file with sections:

```
cnl 1
meta  name="blinker" units=mm
[circuit]      ← netlist (always read first, smallest)
[breadboard]   ← view geometry: placements, wires
[schematic]
[pcb]          ← footprints, tracks, vias, zones, board outline
[tests]
```

The MCP `read` tool returns only `[circuit]` by default, so the expensive geometry sections never enter an AI's context unless asked for. **Decided:** a single file for now. If PCB geometry gets large (thousands of track segments), allow splitting into `project/` with one file per section. The grammar stays the same.

---

## 4. MCP design (priority #1)

### 4.1 Rules

1. **Few tools, wide verbs.** Every tool schema costs tokens on every request. Target **≤ 12 tools and < 2k tokens of total schema**. Prefer one tool with a batch-text argument over many fine-grained tools.
2. **Text over JSON.** Results are compact text (CNL, aligned tables). JSON costs roughly 30–60% more tokens for the same data. `structuredContent` is offered only where a client benefits.
3. **Deltas over dumps.** Mutations return what changed plus new issues, never the whole circuit.
4. **Progressive detail.** `detail=0|1|2` on read-type tools. `0` is a one-line summary and is the default where reasonable.
5. **Bounded output.** Every list is capped with a count and a cursor: `… 214 more (cursor=c3)`.
6. **Actionable errors.** Say what is wrong, what is valid, and the closest match.
7. **Revisions.** Every response carries `rev=N`. Mutations accept `if_rev` for optimistic concurrency, so AI and human can edit live without clobbering each other.
8. **Self-documenting.** The `help` tool and MCP resources hold the grammar, examples and part-family cheatsheets, so the base tool descriptions stay short.

### 4.2 Tool set (v1)

| Tool | Purpose | Example input → output |
|---|---|---|
| `project` | new / open / save / list / close / **fork** | `fork name=try-led` → `ok project=try-led rev=0 (from blinker@12)` |
| `read` | circuit or view as CNL; selectors; `since=rev` for changes | `select=U1,net:VCC detail=1` |
| `edit` | apply CNL edit batch, atomic, `dry_run`, `if_rev` | → `ok rev=13 +R3 ~LA(+1 pin) · 1 warn: R3.2 unconnected` |
| `find` | search part library | `q="nand 5v dip"` → `74hc00  quad NAND  14p  DIP/SOIC  sim:logic` |
| `part` | one part's pins/props/models/footprints | `74hc00` → pin table, one line per pin |
| `check` | ERC / DRC / view-consistency | → `2 err 1 warn` + one line per issue |
| `sim` | run analysis or file tests | `op` / `tran 10m probes=V(LA)` / `logic` / `test "*"` |
| `layout` | auto place / wire / route per view | `view=bb op=place,wire` → `ok placed 5, wired 7, 0 unroutable` |
| `render` | view → PNG/SVG for vision models, optional crop | `view=sch` → image |
| `export` | gerber / kicad / spice / bom / svg | → file path + summary |
| `history` | undo / redo / log / checkpoint / restore | `log n=5` |
| `help` | grammar, examples, topics | `help edit` |
| `ext` | list / call plugin tools (lazy, see §7) | `list` → one line per plugin tool |

### 4.3 Simulation output is summarized, not dumped

```
sim tran 10m probes=V(LA),I(D1)
→ ok tran 10ms 2001pts rev=13
  V(LA)  min 0  max 1.98  final 1.98  rise(10-90%) 0.4us
  I(D1)  min 0  max 9.4m  final 9.4m
  data: sim://13/tran/1 (csv, on request)
```

- Logic sims return a **transition table** (only rows where something changes) or truth tables.
- Raw waveforms are MCP resources, fetched only if needed.
- `expect` assertions return `PASS` / `FAIL` with the measured value, so verifying something costs a few tokens.

### 4.4 Exploring and testing cheaply

- **`fork`**: copy-on-write sandbox projects. Try an idea, simulate, then discard or merge back.
- **`dry_run`** on every mutation.
- **`read since=rev`** returns what the human changed in the UI since the AI last looked. This is how the AI stays in sync with live edits.
- **`help examples`** gives small canonical circuits to copy from (blinker, H-bridge, 555, Arduino button, logic counter).
- **Deterministic sims** (fixed seeds, fixed timestep options) make results reproducible across runs.

### 4.5 Transports and modes

- `cadllm mcp`: **stdio**, headless, for Claude Code/Desktop and other local agents.
- `cadllm serve`: engine + web UI on `localhost` + **Streamable HTTP** MCP endpoint. AI edits appear live in the user's open UI, highlighted and attributed ("AI changed R1"), and undo works across both.
- The stdio server can **attach** to a running `serve` instance when one exists, so there is one engine and one source of truth.

### 4.6 Measured, not assumed

We maintain an **MCP benchmark suite**: scripted agent tasks ("build a 5V LED with correct resistor and prove current < 20 mA", "make a 2-bit counter and verify its truth table"). For each task we track **tokens-to-success, tool calls and success rate** per model. It runs in CI. A regression in tokens is a bug like any other.

### 4.7 Sketch: a full task in ~5 calls

```
find q="led"                    → led  (red/green/…)  2p A,K  sim:diode
edit  BAT1 battery 5V
      R1 res 150 ; D1 led red
      VCC: BAT1.+ R1.1 ; LA: R1.2 D1.A ; GND: D1.K BAT1.-
                                → ok rev=1 +3 comps +3 nets · 0 issues
sim   op probes=I(D1)           → I(D1) 19.8m
edit  ~R1 value=220             → ok rev=2
sim   op probes=I(D1) expect="I(D1)<20m"  → I(D1) 13.6m PASS
```

---

## 5. Architecture

```
 ┌────────┐  ┌─────────┐  ┌────────┐  ┌──────────┐
 │ Web UI │  │   MCP   │  │  CLI   │  │ Plugins  │   ← all clients
 └───┬────┘  └────┬────┘  └───┬────┘  └────┬─────┘
     └────────────┴──────┬────┴────────────┘
                 ┌───────▼────────┐
                 │     ENGINE     │  sessions, projects, revisions,
                 │  (public API)  │  transactions, events, plugin host
                 └───────┬────────┘
   ┌──────────┬──────────┼──────────┬──────────┬───────────┐
 core        dsl       library     sim-*      render      layout
 model+ops   CNL       parts,      digital,   doc→SVG     place,
 undo/rev    parse/    importers   analog,    (pure,      wire,
 validate    print                 mcu        headless)   route
```

- **core** is pure TypeScript with no DOM or Node APIs, so it runs in the browser, Node, workers and tests.
- **Every mutation runs in a transaction** (`doc.transact(tx => …)`) on a draft copy, which is committed only if every step succeeds. Committed circuits are immutable and double as history snapshots: undo/redo restores them, and `since=rev` deltas are structural diffs by stable id. This is simple and correct by construction at netlist sizes. If PCB-scale documents make snapshots too heavy, move to an op log (which would also enable CRDT/OT collaboration) behind the same API.
- **Stable ids under the hood.** Components have immutable ids (`c7`), and nets store pins as `componentId:pinId`. Refs (`R1`) and net names are just renameable labels.
- **Net-join rule:** listing a pin that's already on another net joins the nets. Auto nets (`N3`) merge silently into named nets, and the merge is reported in the result. Joining two *named* nets is refused as a likely short, with a hint showing the deliberate `mv A B` merge.
- **render** is a pure function `(doc, view, options) → SVG string`. The UI uses it and so does the headless MCP `render` tool (PNG via resvg). There is one renderer, not two.
- The **engine** is the only stateful layer. The UI talks to it over WebSocket JSON-RPC in `serve` mode, or embeds it in-browser for a fully static build.

---

## 6. Technology choices

| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript (strict)** everywhere | One language for engine, UI, MCP and plugins, so contributors and plugin authors need only one. Hot paths can move to Rust/WASM behind interfaces later. |
| Runtime | Node ≥ 22 | Official MCP TS SDK, worker_threads |
| Monorepo | **npm workspaces**, no build step: Node 24 runs the `.ts` sources directly (type stripping), packages export `src/index.ts` | Zero extra tooling. Requires erasable-only TS (no enums, no parameter properties). |
| Schemas | **Zod** → JSON Schema | One definition validates input, generates MCP schemas, types and docs |
| MCP | `@modelcontextprotocol/sdk` | Official SDK |
| Tests | **Vitest**, plus golden-file tests for CNL and SVG | |
| UI | **React** for panels/chrome; views drawn from the `render` SVG, with **Canvas/WebGL (PixiJS)** for PCB if SVG DOM gets slow | SVG works for breadboard and schematic and keeps parity with headless render |
| Digital sim | **Own event-driven engine** (4-state 0/1/X/Z, propagation delays) | Small, fast, deterministic, fully ours |
| Analog sim | **ngspice compiled to WASM** (BSD-licensed, GPL-compatible) | Industry-standard SPICE. Spike it in M0. Fallback is our own MNA DC solver for basics. |
| MCU sim | **avr8js** (Arduino Uno/Nano, MIT), **rp2040js** (Pico, MIT) | Tinkercad-like Arduino simulation in the browser |
| PCB routing | Own interactive router. Auto-routing via **Freerouting** (GPL-3) over Specctra DSN as an optional external tool. | Don't write an autorouter early |
| Desktop | **Electron** (M5). It bundles Node, so the engine and MCP run unchanged. For now `cadllm serve` opens the browser. | |

---

## 7. Plugin system ("plugin-ready" from day 1)

### 7.1 Everything is a contribution

Built-in features ship as **first-party plugins** using the same contracts. If the core library can't be expressed as plugins, the plugin API is too weak.

Contribution points:

| Point | Example |
|---|---|
| `parts` | A part pack: Arduino shields, sensors (data only, no code) |
| `models` | Simulation model: digital behavior (JS), SPICE subcircuit, MCU core (WASM) |
| `tools` | Extra MCP tools exposed via `ext` |
| `commands` | UI commands and keybindings |
| `panels` | UI panels (sandboxed iframe) |
| `importers` / `exporters` | Eagle, EasyEDA, JLC BOM/CPL, … |
| `checks` | Custom ERC/DRC rules |
| `layout` | Alternative placers and routers |
| `themes` | Colors, breadboard skins |

### 7.2 Manifest

```jsonc
// plugin.json
{
  "id": "org.example.sensors",
  "name": "Example Sensor Pack",
  "version": "1.2.0",
  "engine": "^1.0.0",            // public API semver range
  "license": "MIT",              // any license allowed via the plugin exception (§9)
  "permissions": ["project:read", "project:write", "net:api.example.com"],
  "contributes": {
    "parts": "parts/",
    "models": [{ "id": "dht22", "kind": "digital", "main": "dist/dht22.js" }],
    "tools": [{ "name": "calc_divider", "summary": "solve resistor divider" }]
  }
}
```

### 7.3 Runtime and safety

- **Data-only plugins** (part packs, SPICE models, themes) run no code. They are safe by default and will be the most common kind.
- **Code plugins** run in an **isolated worker** (Web Worker / worker_thread) and talk to the engine through a **capability-based RPC API** (`@cadllm/plugin-api`). They get no ambient filesystem or network access, only what the manifest declares and the user grants.
- **UI panels** run in sandboxed iframes with a postMessage API (Figma-style).
- Plugin MCP tools are **lazy**. They are not registered as top-level MCP tools (which would bloat every prompt) but are discovered via `ext list` and invoked via `ext call`. A plugin may request "pinned" top-level status, and the user approves that.
- The public API is **semver-versioned**, separate from internals, and documented from the Zod schemas.

### 7.4 Store (later, no architecture change needed)

- The registry is a git repository with an index (`id, repo, version, sha256, signature, permissions`). Installs verify the hash.
- The store UI is just a client of the registry index. The GitHub Pages site can render the same index.

---

## 8. Part library

One folder per part:

```
parts/logic/74hc00/
  part.cnlp        pins, aliases, props, families, datasheet url (CNL-style text)
  symbol.svg       schematic symbol (pin anchors as SVG ids)
  breadboard.svg   breadboard art (pin anchors as SVG ids)
  footprints/      DIP-14.kicad_mod, SOIC-14.kicad_mod (KiCad format, reused as-is)
  model.js | model.cir   digital behavior or SPICE subckt
```

- **Importers:** KiCad symbols/footprints (s-expr) and Fritzing `.fzpz`. Bootstrapping from existing libraries saves years. We must respect their licenses (CC-BY-SA, with attribution).
- Parts are **generated where possible** (resistors, headers, DIP/SOIC packages from parameters), not hand-drawn one by one.
- Every part has a **token-cheap summary line** for `find` results.

---

## 9. Licensing

- **App: GPL-3.0-or-later.** SPDX headers in every file.
- **Contributions: DCO** (`Signed-off-by`), which is lightweight and has no CLA.
- **Part library: CC-BY-SA 4.0** with an exception stating that designs and products made with the parts are not bound by it (KiCad's approach).
- **User designs are the user's.** Using the tool imposes no license on circuits.
- **Plugin licensing: DECIDED (2026-11-22): GPL-3.0-or-later + plugin exception.** This is an additional permission under GPLv3 §7, shipped as `LICENSE-EXCEPTION.md` next to `LICENSE`:
  - Plugins that interact with the app **only through the published `@cadllm/plugin-api`** (manifest, RPC API, data formats) may use **any license**, including proprietary and commercial.
  - The exception does **not** cover modifying or copying app code into a plugin. That remains GPL.
  - Every source file's SPDX header reads `GPL-3.0-or-later WITH CadLLM-plugin-exception`, so the exception is attached from the first commit and all contributions arrive under it via the DCO.
  - The store shows each plugin's license, and the store and registry may filter by "open source only".
  - Practical consequence: the plugin API boundary is a **legal** boundary too, so it must stay explicit and documented, and internals must never leak into it.
  - Before publishing, have the exception text reviewed. GCC's runtime exception and the Classpath exception are the models to follow.
- Dependencies must be GPL-3-compatible (MIT, BSD, Apache-2.0, LGPL, GPL-3). CI runs a license check.

---

## 10. Repository layout

```
cadllm/            (layout target; packages appear as they're built)
  packages/
    core/          model, ops, transactions, revisions, validation
    dsl/           CNL parser + printer (+ golden tests)
    library/       part schema, loader, KiCad/Fritzing importers, generators
    sim-digital/
    sim-analog/    ngspice-wasm adapter
    sim-mcu/       avr8js / rp2040js adapters
    render/        doc → SVG per view
    layout/        placement, breadboard auto-wire, schematic layout, routing
    engine/        sessions, events, plugin host, public API
    plugin-api/    public types + manifest schema (published to npm)
    mcp/           MCP server (stdio + HTTP), thin over engine
    cli/           cadllm: serve | mcp | test | export | lint
    ui/            web app
  parts/           built-in library (data, as first-party plugin)
  examples/        canonical .cnl circuits (also used by `help examples`)
  bench/           MCP token benchmark tasks
  docs/
```

---

## 11. Roadmap

Order follows "MCP is #1". The engine and MCP come before any UI.

| Milestone | Delivers | Done when |
|---|---|---|
| **M0 Engine + MCP** | core, CNL, engine, MCP (`project read edit find part check sim help history`), ~40 parts (R C L LED diode battery switch pot, 74HC gates/flip-flops, breadboard), digital sim, DC operating point, `cadllm test`, token benchmark | An agent builds and verifies an LED circuit and a 2-bit counter in ≤ 6 calls with no UI |
| **M1 UI** | `serve`, schematic + breadboard views, live AI edits, `render`, auto place/wire | A human and an AI co-edit one project live |
| **M2 Sim++** | ngspice transient/AC, mixed-signal bridge, Arduino via avr8js with code editor | Arduino blink + button sim matches Tinkercad behavior |
| **M3 PCB** | footprints, PCB view, interactive routing, DRC, Gerber/drill, KiCad import/export | Gerbers pass a fab house's viewer |
| **M4 Plugins** | plugin runtime, sandbox, `ext`, first external plugin, registry index | A third-party part pack + MCP tool installed from the index |
| **M5 Public** | GitHub repo, Pages site, store UI, desktop package | — |

---

## 12. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Plugin license exception (§9) | ✅ **Decided:** GPL + plugin exception |
| 2 | Project name (CadLLM is a placeholder) | ⏳ **Deferred:** keep CadLLM until just before the public repo; check npm/GitHub availability then |
| 3 | Desktop shell | ✅ **Decided:** Electron, packaged in M5. Until then the app runs in the browser via `cadllm serve`. |
| 4 | Single file vs folder project format for large PCBs | ✅ **Decided:** single `.cnl` file now; optional folder mode in M3 only if needed |
| 5 | ngspice-wasm vs own analog solver | ✅ **Decided:** spike ngspice-wasm in M0, with our own MNA DC solver as fallback |
