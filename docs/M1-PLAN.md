# M1 Plan: UI + live co-editing

Goal (FOUNDATION §11): **a human and an AI co-edit one project live.** `cadllm serve` opens a browser UI with schematic and breadboard views. An AI connected over MCP edits the same project, and each side sees the other's changes immediately, attributed and highlighted, with shared undo.

## Decisions (made with the user, 2026-11-22)
- **UI:** React + Vite, only in `packages/ui`. Everything else stays no-build.
- **Breadboard look:** clean illustrated (Tinkercad-like). Flat shapes, a real hole grid, colored wires, no photo textures.
- **Schematic symbols:** ANSI/IEEE (zigzag resistor). In M1, ICs are a box symbol with named pins; per-gate ANSI units come later.
- **Wires are derived, never stored (M1).**
  - Schematic wires are auto-routed from the netlist on every render.
  - Breadboard jumpers are generated from strip connectivity.
  - The AI only edits parts, nets and placements (`R1 @sch:12,4,90`, `U1 @bb:E10`). Manual wire waypoints can come later as extra place data, with no grammar change.
- **One renderer.** `@cadllm/views` is pure TypeScript (no Node or DOM APIs). The browser imports it to draw locally, and the server uses it for MCP `render` (SVG → PNG via resvg).

## Status

| Piece | State |
|---|---|
| core `PartDef.views` + `parts/` families | ✅ (generator `VIEWS` table, validated, tested) |
| engine `Workspace` + per-client `Engine` sessions, events, attribution | ✅ |
| `@cadllm/views` contract (`types.ts`, `svg.ts`, `index.ts`, stubs) | ✅ |
| M1 dependencies installed (ws, react, vite, resvg) | ✅. **Agents must not run `npm install`.** |
| WP1 schematic view | ⏳ |
| WP2 breadboard view | ⏳ |
| WP3 server | ⏳ |
| WP4 UI | ⏳ |
| WP5 MCP `render`/`layout`, view checks in `check`/`edit`, integration (Claude) | ⏳ after WP1+WP2 |

## Ground rules (in addition to M0's)
- Read first: `docs/FOUNDATION.md` §3–§5, this file, `packages/views/src/types.ts` (the contract), `packages/core/src/*.ts`.
- **Own only your folder.** WP1 owns `packages/views/src/sch/` and `packages/views/test/sch*.test.ts`. WP2 owns `packages/views/src/bb/` and `packages/views/test/bb*.test.ts`. WP3 owns `packages/server/`. WP4 owns `packages/ui/`.
- Don't edit `core`, `engine`, `mcp`, `views/src/{types,svg,index}.ts`, any `package.json` or the lockfile. If the contract needs changing, stop and say so in the reply.
- **Don't run `npm install`.** Every dependency is already installed. Ask if you need another one.
- Deterministic output: the same circuit gives byte-identical SVG. Use golden-string tests for small cases.
- **Done when:** `npm run check` passes at the repo root (WP4: plus `npm run typecheck -w @cadllm/ui` and `npm run build -w @cadllm/ui`). The reply lists files, public API, decisions and open questions.

## Shared conventions
- **Units:** 1 schematic grid step = 1 breadboard hole pitch (0.1 in) = `UNIT` = 10 SVG user units.
- **SVG hooks, which the UI depends on.** Every drawn item carries data attributes:
  - Component group: `<g data-ref="R1">`.
  - Pin: an element with `data-pin="R1.2"`, using the pin label from `Query.pinLabel`.
  - Wire or jumper group: `<g data-net="VCC">`.
  - Breadboard hole: `data-hole="E10"`. Holes are drawn on the board element, so the UI can hit-test them.
  - Highlighted items get `class="hl"`. Root `<svg data-view="sch|bb">`.
- **Themes:** `light` (default) and `dark`, with colors in one CSS `<style>` block per document so the UI can restyle.
- **Part families** come from `PartDef.views` (see the `VIEWS` table in `packages/library/scripts/gen-parts.ts`):
  - sch: resistor capacitor capacitor_pol inductor pot diode led zener battery vsource switch button buzzer probe vcc gnd npn pnp nmos ic board none
  - bb: axial disc radial led pot battery supply slide_switch button buzzer probe to92 dip arduino_uno breadboard none
  - An unknown family falls back to a labeled box with its pins: `ic` for sch, a generic header for bb. Never throw.

## WP1 `views/src/sch`: schematic view (tier: hard)

**Place string:** `x,y[,rot][,m]`. `x,y` are integer grid steps of the symbol origin, `rot` is 0, 90, 180 or 270 (clockwise), and `m` mirrors horizontally. Examples: `12,4`, `12,4,90`, `30,10,0,m`.

**Symbols (ANSI):** one module per family. Each gives:
- body drawing commands;
- pin anchor points on grid intersections, with an outward direction;
- a bounding box, and where the ref and value labels go.
- `ic` / `board`: a box with pins distributed left and right by type (inputs left, outputs right, power top and bottom), sized to fit the pin names.
- `vcc` / `gnd`: the usual power symbols, with the net name as the label.

**Routing (derived):** orthogonal wires on the grid between pin anchors.
- Per net: connect the pins with a rectilinear Steiner/MST approximation, routed by A* on the grid. Avoid symbol bodies. Prefer few bends and draw junction dots at T-joins.
- Nets whose names are power names (GND, VCC, V+, 5V, 3V3…) or that have a vcc/gnd symbol part, and very long runs: draw **net labels / power symbols at each pin** instead of wires. Keep the picture readable.
- An unroutable connection falls back to a dashed straight ratsnest line, plus an issue.
- Wires never pass through pins of other nets.

**autoPlace:** layered left to right by signal flow:
- sources and inputs (battery, switches, buttons) first;
- then ICs, passives in series between, then loads and outputs (LED, buzzer, probe);
- power symbols near their pins.
- Grid spacing leaves room for routing. Already placed parts are fixed obstacles. Deterministic.

**check:**
- `unplaced`: warn, one issue listing every unplaced ref.
- `bad_place`: error.
- `overlap`: warn, when bounding boxes intersect.

**render:** only placed parts are drawn. With no placed parts it returns an empty drawing that says "no schematic placement — layout view=sch".

**Tests:**
- Golden SVG for an LED circuit and the `examples/nand-led.cnl` circuit after autoPlace.
- Rotation and mirror pin positions.
- No wire passes through a symbol body.
- Determinism.
- `select` cropping and `highlight` class.

## WP2 `views/src/bb`: breadboard view (tier: hard)

**Board:**
- The first `breadboard_half` or `breadboard_full` component in the circuit. If there is none, assume an implicit `breadboard_half`.
- Holes are named as in its pins: `A1…J30`, rails `T+1…T+30`, `T-…`, `B+…`, `B-…`.
- Strips: column n rows A–E is one node and F–J is another. Each rail is one node.
- Hole positions follow real geometry: a 0.3 in center channel and rails above and below.
- Export `bbHolePos(q, hole)` and `bbHoleAt(q, pt)`.

**Place strings** (pin 1 first):
- `E10`, for inline parts: pin 1 at E10, the next pins in the following columns with the family's default pitch (axial 4, disc/led/radial/button 2… define per family). For example, TO-92 `E10` gives E, B, C at E10, E11, E12.
- `E10-E14`, for 2-pin parts: explicit endpoints in any direction, including across rows (`E10-F10`).
- DIP `E10`: pin 1 at E10. Pins 1…n/2 run along row E (E10, E11…). The other half is on row F, numbered back (pin n at F10). The part straddles the channel.
- Off-board parts (battery, supply, arduino_uno, or any part placed as `x,y`): `x,y` in hole pitches relative to the board's top-left. Their pins connect by jumpers.
- `bb: none` families (vcc/gnd symbols) are not drawn. Their nets are served by rails.

**Connectivity and jumpers (derived):**
1. Map each placed pin to its hole, then to its strip node.
2. `bb_short` (error): one strip holds pins of different nets.
3. For every net, group its pins by node. Off-board pins are their own nodes.
4. Connect the groups with jumpers (deterministic MST by distance). Each jumper uses a free hole in each strip and is drawn as a colored wire. Use red for VCC-like nets, black or blue for GND, and a stable palette by net name for the rest.
5. **Power nets go to rails:**
   - Nets driven by a battery/supply `+` or named like VCC/5V take the `+` rail.
   - GND takes the `-` rail.
   - Each net gets one rail and all its strips jump to that rail.
6. `strip_full` (warn) when no free hole is left.

**autoPlace:** the breadboard-natural layout.
- ICs straddle the channel, left to right.
- 2-pin and 3-pin parts go in free columns, **chosen so connected pins share strips where possible**, which minimizes jumpers.
- Sources go off-board on the left.
- Never create `bb_short`. Placed parts are fixed. Deterministic.

**check:** `unplaced` (warn), `bad_place`, `off_board`, `overlap` (two pins in one hole, error), `bb_short`, `strip_full`.

**render:**
- The board drawing has every hole as an element with `data-hole`.
- Parts are drawn per family, flat and recognizable:
  - resistor body with color bands computed from `resistance`;
  - LED dome colored from `color`;
  - DIP with a notch and the part id;
  - TO-92 half-round;
  - button square;
  - battery block with `+`/`-`.
- Jumpers are drawn as gently curved paths.
- The schematic rules for `select` and `highlight` apply here too.

**Tests:**
- Golden SVG for an LED circuit on a half breadboard.
- DIP pin mapping.
- Strip grouping and rail assignment.
- `bb_short` detection.
- autoPlace on `examples/nand-led.cnl` produces 0 errors.
- `bbHoleAt(bbHolePos(h)) === h` for all holes.
- Determinism.

## WP3 `packages/server`: `cadllm serve` (tier: standard)

**API:** `startServer({ port?, host?, root?, open?: string /* .cnl */ }) → Promise<{ url, close() }>` and `main(argv)` for `cadllm serve [file.cnl] [--port 5170]`. WP5 wires it into the CLI.

**Process model:**
- One `Workspace` (`@cadllm/engine`). Every WebSocket connection gets `new Engine({ workspace, source: 'user' })`, and every MCP session gets `source: 'ai'`.
- Bind `127.0.0.1` only. Reject WebSocket and MCP requests whose `Origin`/`Host` isn't localhost (DNS-rebinding guard).

**HTTP:**
- `/` serves `packages/ui/dist` (static). If it isn't built, show a small page saying `npm run build -w @cadllm/ui`.
- `/mcp`: Streamable HTTP MCP, stateful with an `Mcp-Session-Id`, through `createServer(engine)` from `@cadllm/mcp`.

**WebSocket `/ws`:** JSON-RPC 2.0.
- Requests:
  - Every MCP tool name (`project read edit find part check sim history help`), with the same params. The result is the same text.
  - `state {}` → `{ project, rev, projects: {name, rev, source?}[], circuit: Circuit, parts: Record<id, PartDef> }` (only the parts in use).
  - `library {}` → `PartDef[]`.
  - `render { view, highlight?, theme? }` → SVG string.
- Errors use `{ code: -32000, message: errorText(err) }`.
- Notifications: `changed { project, rev, source, label?, delta, summary }` for **every** workspace change from any client, and `projects { names }` on open/close.

**Attach:**
- `serve` writes `~/.cadllm/serve.json` `{ port, pid }` and removes it on exit.
- Export `findServe(): Promise<string | undefined>`, which returns the URL if the pid is alive and the port answers.
- Export `proxyStdio(url)`, which bridges stdio MCP to the HTTP MCP endpoint (SDK client + server forwarding of tools/list and tools/call). WP5 makes `cadllm mcp` use it when a serve is running.

**Tests (the M1 done-when test):**
1. Start on a random port.
2. Connect an MCP HTTP client (AI) and a `ws` client (user).
3. The AI `edit` produces a `changed` notification with `source: 'ai'` on the ws.
4. The user `edit` over ws shows up in the AI's `read since=…`.
5. `state` returns the circuit, and an Origin check rejects a foreign origin.

## WP4 `packages/ui`: browser UI (tier: hard)

**Setup:**
- Vite + React 19 + TypeScript, with its own `tsconfig.json` (DOM lib, `jsx: react-jsx`, `allowImportingTsExtensions`, `noEmit`).
- `vite.config.ts` proxies `/ws` and `/mcp` to `localhost:5170` in dev. `build` outputs `dist/`.
- Import `@cadllm/core` (Query only) and `@cadllm/views` directly, and render in the browser. Never import `@cadllm/library` (it uses node:fs). Build a `PartResolver` from the `library` RPC.

**Layout:**
- Top bar: project picker (`project list/use/new/open/save`), undo/redo, connection status.
- Left: the part picker, using `find` with a search box. Clicking a part adds it as `<ref> <part>` with an auto ref, placed at the view center.
- Center: tabs Schematic | Breadboard, showing the SVG from `views.render`. Pan and zoom.
- Right: an inspector for the selected component (props editable → `~R1 k=v`), plus a CNL text pane (the `read` output, editable, Apply → `edit`).
- Bottom: a sim/check console (input runs `sim run=…`; shows `check`), plus an activity log of `changed` notifications.

**Interactions:**
- Click selects (using `data-ref`).
- Drag moves a part and snaps to grid or holes. On drop it sends one `edit` with the new place string: sch `x,y,rot`, bb hole via `bbHoleAt`.
- `R` rotates (sch).
- Delete sends `-R1`.
- Drag from pin to pin (using `data-pin`) connects them. Pin A's existing net is reused, else a new `N<k>` net.
- "Auto layout" button calls `layout` (falls back to a notice until WP5 lands).

**Live co-editing:**
- On a `changed` notification from another source: refresh `state`, highlight the changed refs and nets (`highlight` option) for ~3 s, and show a toast "AI changed R1 ~LA".
- The local user's own changes are not toasted.
- Undo/redo is shared (`history`).

**Tests:**
- Vitest unit tests for the pure helpers (place-string math, the RPC client with a fake socket, delta-to-highlight mapping).
- Typecheck and build must pass. A dev-only `?demo` mode with a canned state helps manual testing.

## WP5 (Claude, after WP1+WP2, alongside WP3/WP4)
- MCP and engine `layout { view, refs?, all? }`: applies `autoPlace` as one edit, and reports placed counts, jumpers and conflicts.
- `render { view, select?, highlight? }`: returns a PNG image (resvg), plus a one-line text summary.
- View issues in `check`, and in the `edit` issue tail for touched items.
- `cadllm serve`, and `cadllm mcp` attaching when a serve is running.
- An end-to-end co-edit demo, and a benchmark update (token cost of `layout` and `render`).
