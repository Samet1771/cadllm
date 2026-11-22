# M3 Plan: PCB (footprints, PCB view, routing, DRC, Gerber/drill, KiCad)

Goal (FOUNDATION §11): **Gerbers of the example boards pass a fab house's viewer** — checked by an independent Gerber parser/renderer in CI tests, then uploaded to a fab viewer once by hand.

## Decisions (recorded in WP0)
1. **Parametric footprints:** generated in-repo (`@cadllm/pcb`) using IPC-7351 nominal densities, keyed by the existing names in `PartDef.footprints` (`DIP-14`, `DIP-8`, `DIP-16`, `SOIC-14`, `SOIC-8`, `SOIC-16`, `THT-axial`, `DO-35`, `DO-41`, `SOD-123`, `LED_D5.0mm`, `LED_D3.0mm`, `TO-92`, `SOT-23`, `0805`, `C_Disc_D5.0mm`, `L_Axial_L5.3mm`, `Header_1x02_P2.54mm`, `Potentiometer_THT_9mm`, `SW_SPST_THT`, `SW_PUSH_6mm`, `Buzzer_12mm`, `CP_Radial_D5.0mm_P2.00mm`, `CP_Radial_D8.0mm_P3.50mm`, `Arduino_Uno_R3` shield outline with header pads, `BatteryHolder_9V`, `WireLeads`). A component uses `props.footprint` if set, else the part's first footprint. Breadboard parts and `views.pcb`-less symbols (`vcc_symbol`, `gnd_symbol`, `logic_probe`) are excluded from PCB. KiCad `.kicad_mod` import is WP5.
2. **Own router first:** a deterministic 2-layer (`F`/`B`) grid/maze (Lee/A*) router in TypeScript with vias and rip-up-and-retry for small boards. Freerouting (Specctra DSN/SES, Java) is a later optional add-on, out of M3.
3. **Gerber/drill validation:** `@cadllm/export` tests parse and render every generated Gerber + Excellon layer using `@tracespace/core` (`5.0.0-alpha.0`, MIT) in Node 24 (devDependency only) and check pad/track counts and board extents. Nothing is sent over the network; the user uploads the final zip to a fab viewer manually.
4. **PCB copper is stored, not derived:** `Circuit.pcb` stores `{ board?: { outline }, rules?: { clearance, track, via, drill }, tracks: { net, layer, width, points }[], vias: { net, at, size, drill }[] }` keyed by stable `net` id (`Net.id`) so net renames stay valid. `Delta.pcbNets` reports net names whose copper changed (`printDelta`: `pcb: ~VCC`). Removing a net drops its copper; merging nets moves copper to the surviving net id; undo/redo/since keep working via immutable `Circuit` snapshots.
5. **CNL grammar (`[pcb]` section and `edit` lines):**
   - Placement: `U1 @pcb:12.7,8,90 top` (`x,y[,rot][,top|bottom]`, mm, clockwise deg, default `top`).
   - Board: `board 50x40` (0,0 rectangle) or `board 0,0 50,0 50,40 0,40` (polygon).
   - Rules: `rules clearance=0.2 track=0.25 via=0.6 drill=0.3` (mm; defaults shown).
   - Track: `track VCC F 0.4 10,10 20,10 20,15` (net name, `F|B`, width mm, >=2 points; appends).
   - Via: `via VCC 20,15` (optional `size=`/`drill=`, else from rules).
   - Remove copper: `-tracks VCC` (one net) or `-tracks *` (all copper) in `edit` batches.
   - `saveCnl` writes `[pcb]` with placements first, then `board`, `rules`, then tracks/vias grouped by net in natural order; `loadCircuit(saveCnl(d))` round-trips identically.
6. **MCP surface (12 tools):**
   - `layout` gains `view='pcb'`, `op?: 'place' | 'route'` (default `place`), `nets?`: `layout view=pcb` auto-places footprints; `layout view=pcb op=route [nets=VCC,GND]` autoroutes unrouted connections.
   - `render` gains `view='pcb'`.
   - `check` runs PCB DRC + connectivity when the circuit has PCB placement or `pcb` data.
   - New tool `export { format: 'gerber' | 'drill' | 'fab' | 'kicad' | 'bom' | 'pnp' | 'svg'; view?; path? }` writes files under the project directory (or `path`) and returns paths + summary.

## Status

| Piece | State | Summary |
|---|---|---|
| WP0 contracts, `Circuit.pcb`, CNL `[pcb]` grammar/round-trip, MCP/Engine wiring, `examples/led-pcb.cnl`, deps | ✅ | Contracts, CNL `[pcb]` grammar/round-trip, Engine/MCP `layout`/`render`/`check`/`export`, `examples/led-pcb.cnl`. |
| WP1 `@cadllm/pcb` footprints, placement, PCB `View` (`render` / `autoPlace` / `check` place) | ✅ | 28 parametric footprints; pads; PCB render; autoPlace; placement checks; header_1x02/1x03 parts. |
| WP2 `@cadllm/pcb` connectivity graph, ratsnest, DRC, 2-layer A* autorouter | ✅ | connectivity/ratsnest; 9 DRC rules; 2-layer A* router with vias and rip-up — routes both examples in < 30 ms. |
| WP3 `@cadllm/export` RS-274X X2 Gerbers, Excellon drill, BOM/PnP CSV, fab zip, `fab-preview.ts` | ✅ | RS-274X X2 Gerbers, Excellon PTH/NPTH, BOM, pick-and-place, fab zip; validated by @tracespace/core; `packages/export/scripts/fab-preview.ts`. |
| WP4 `@cadllm/ui` PCB tab, layer toggles, drag/rotate/flip, interactive routing, DRC panel, Autoroute/Export | ✅ | UI PCB tab with layers, drag/rotate/flip, interactive 45° routing, DRC panel, autoroute/export buttons. |
| WP5 `@cadllm/kicad` `.kicad_mod` importer and KiCad 9 `.kicad_pcb` exporter | ✅ | `.kicad_mod` import, KiCad 9 `.kicad_pcb` export, s-expr round trip. |

## Ground rules (in addition to M0–M2)
- **Read first:** `docs/FOUNDATION.md` (§3, §4, §11), this file, and the WP0 contracts (`packages/pcb/src/types.ts`, `packages/pcb/src/index.ts`, `packages/export/src/index.ts`, `packages/kicad/src/index.ts`, `packages/core/src/types.ts`).
- **Own only your folder:**
  - **WP0:** `packages/pcb/src/types.ts`, `packages/pcb/src/index.ts`, and nothing else in `packages/pcb/` after WP0.
  - **WP1:** `packages/pcb/src/{footprints,place,view}/` and `packages/pcb/test/`
  - **WP2:** `packages/pcb/src/{route,drc,connect}/` and `packages/pcb/test/`
  - **WP3:** `packages/export/`
  - **WP4:** `packages/ui/`
  - **WP5:** `packages/kicad/`
- **No `npm install` for WP1–WP5.** All M3 dependencies (`fflate`, `@tracespace/core`) are already installed in WP0.
- **Node 24 erasable TypeScript:** no `enum`, `namespace`, or constructor parameter properties; `.ts` import extensions; SPDX header (`GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception`) on every new source file.
- **Deterministic output:** sorted keys/items, fixed precision, no timestamps or randomness.
- **Done when:** `npm run check` passes at the repo root (WP4: plus `npm run typecheck -w @cadllm/ui` and `npm run build -w @cadllm/ui`).

## Shared conventions
- **Units:** millimetres (`mm`) everywhere in PCB data, CNL, footprints, pads, tracks, vias, board outline, and rules.
- **Coordinate system:** origin top-left with `+x` right and `+y` down (matching SVG).
- **Rotation:** clockwise degrees (`0`..`360`); `side` is `'top' | 'bottom'` (default `'top'`).
- **Layers:** `'F'` (front/top copper) and `'B'` (back/bottom copper). Pad layers: `'TH' | 'F' | 'B'`.
- **Pad IDs:** equal to physical pin IDs (`PinDef.id`, e.g. `"1"`, `"2"`, `"D13"`).
- **SVG scaling:** `1 mm = UNIT` SVG user units (`UNIT = 10`, so `0.1 mm = 1` SVG unit). Root `<svg data-view="pcb">`, component groups `<g data-ref="R1">`, pads with `data-pin="R1.2"`, nets `<g data-net="VCC">`, highlighted items `class="hl"`.

## WP1 `packages/pcb/src/{footprints,place,view}/`: footprints, placement, PCB view (tier: hard)
- **Footprints (`footprints/`):** parametric generators (IPC-7351 nominal densities) covering every footprint name in `parts/` (`DIP-*`, `SOIC-*`, `THT-axial`, `DO-35`, `DO-41`, `SOD-123`, `LED_D5.0mm`, `LED_D3.0mm`, `TO-92`, `SOT-23`, `0805`, `C_Disc_D5.0mm`, `L_Axial_L5.3mm`, `Header_1x02_P2.54mm`, `Potentiometer_THT_9mm`, `SW_SPST_THT`, `SW_PUSH_6mm`, `Buzzer_12mm`, `CP_Radial_D5.0mm_P2.00mm`, `CP_Radial_D8.0mm_P3.50mm`, `Arduino_Uno_R3` shield outline + header pads, `BatteryHolder_9V`, `WireLeads`). Export `footprint(name)`, `isPcbPart(part)`, `componentFootprintName(part, comp)`.
- **Placement (`place/`):** `parsePcbPlace`, `formatPcbPlace`, `pads(q)` (transform local pad coords by component `x,y,rot,side` into world mm), and `autoPlacePcb(q, opts)` placing unplaced/all PCB parts inside `pcb.board` (or auto-sized board), avoiding courtyard overlaps and grouping by net connectivity.
- **PCB View (`view/`):** implement `pcb: PcbView` (`render`, `autoPlace`, `check` delegating place + DRC). `renderPcb(q, opts)` draws board outline (`Edge.Cuts`), F/B copper pads, mask openings, F/B tracks, vias, silkscreen + ref/value labels, optional courtyard, and ratsnest for unrouted connections; pure and `state`-free (or ignores `state`), supporting `layers`, `select`, `highlight`, `theme`, `labels`.
- **Tests:** datasheet pitch checks (DIP 2.54 / 7.62 mm, TO-92 1.27 mm, axial 10.16 mm default, 0805 nominal pads), rotation/bottom-side pad transforms, `autoPlacePcb` + `renderPcb` on `examples/led-pcb.cnl` and `examples/nand-led.cnl`, determinism.

## WP2 `packages/pcb/src/{route,drc,connect}/`: connectivity, DRC, autorouter (tier: hardest)
- **Connectivity (`connect/`):** build physical copper connectivity graph from `pads(q)`, `pcb.tracks`, and `pcb.vias` (segment/point intersection + pad/via containment per layer). Compute `ratsnest(q)` as deterministic MST per net over unconnected copper islands.
- **DRC (`drc/`):** implement `drc(q)` returning `DrcIssue[]` covering: `unplaced` (warn), `bad_place` (error), `off_board` (error: part/pad/track outside board outline), `overlap` (error: courtyard overlap), `short` (error: different nets touching on copper), `clearance` (error: pad-pad / pad-track / track-track / via clearance < `rules.clearance`), `track_width` (error: track width < `rules.track`), `drill` (error: drill < `rules.drill` or via drill >= size), `unrouted` (warn/error: remaining ratsnest connections).
- **Autorouter (`route/`):** deterministic 2-layer (`F` / `B`) grid A* router with vias (`via` cost > bend cost > layer preference), clearance haloing from `rules`, and rip-up-and-retry. Supports `opts.nets` and `opts.reroute`.
- **Tests:** unit tests for each DRC rule, copper island merging, ratsnest MST, and end-to-end routing of `examples/led-pcb.cnl` and `examples/nand-led.cnl` producing 0 DRC errors.

## WP3 `packages/export/`: Gerbers, drill, BOM/PnP, fab zip (tier: hard)
- **Gerbers (`gerbers(q)`):** RS-274X (mm, 4.6 format) with Gerber X2 `%TF.FileFunction,...*%` attributes for `F.Cu`, `B.Cu`, `F.Mask`, `B.Mask`, `F.Silkscreen`, `B.Silkscreen`, and `Edge.Cuts`, using aperture macros where needed for rotated/rounded-rect pads.
- **Excellon (`excellon(q)`):** `METRIC,TZ` PTH and NPTH drill files covering TH pads and vias.
- **Assembly (`bom(q)`, `pickAndPlace(q)`):** deterministic CSVs grouped/sorted naturally by ref.
- **Zip (`fabZip(q)`):** bundles all Gerbers, drill files, BOM, and PnP using `fflate`.
- **Preview script:** `packages/export/scripts/fab-preview.ts <file.cnl> <outdir>` writes the fab zip plus PNG previews (`@resvg/resvg-js` over `@tracespace/core` SVGs) for human review.
- **Tests:** validate every generated Gerber + Excellon file with `@tracespace/core`, render layers, and verify pad/track counts and board extents on `examples/led-pcb.cnl` and `nand-led`.

## WP4 `packages/ui/`: PCB tab & interactive routing (tier: hard)
- Add **PCB** tab alongside Schematic and Breadboard.
- Layer visibility toggles (`F`, `B`, `silk`, `outline`, `ratsnest`, `courtyard`).
- Drag footprints (snap 0.5 mm), `R` rotate, `F` flip (`top`↔`bottom`), `Del` remove.
- Interactive routing mode: click pad → click bends → click target pad commits `track` (and `via` on `V` key to switch `F`↔`B`); `Esc` cancels.
- DRC issues panel (clickable to highlight/select), **Autoroute** button (`layout view=pcb op=route`), and **Export** button (`export format=fab`).
- Keep `npm run typecheck -w @cadllm/ui`, `npm run build -w @cadllm/ui`, and unit tests green.

## WP5 `packages/kicad/`: KiCad import/export (tier: standard)
- **`importKicadMod(text)`:** parse `.kicad_mod` S-expressions (pads, shapes, drills, layers, `fp_line`/`fp_circle`/`fp_rect`/`fp_poly` silk, courtyard) into `Footprint`.
- **`exportKicadPcb(q)`:** emit KiCad 9 `.kicad_pcb` S-expression with board outline (`Edge.Cuts`), nets, placed footprints, tracks (`segment`), and vias.
- **Tests:** round-trip footprint properties, parse generated `.kicad_pcb` back with an S-expression parser to verify structure, nets, footprints, segments, vias, and edge cuts.

## Measured

- **Footprints:** 28 parametric IPC-7351 generators + `header_1x02` / `header_1x03` parts.
- **DRC & Autorouter:** 9 DRC rules (`unplaced`, `bad_place`, `off_board`, `overlap`, `short`, `clearance`, `track_width`, `drill`, `unrouted`); 2-layer (`F`/`B`) A* router with vias and rip-up routes `examples/led-pcb.cnl` (8 pads, 5 tracks, 0 vias, 0 err, 0 warn) and `examples/nand-led.cnl` (0 err) in < 30 ms.
- **Export:** 7 RS-274X X2 Gerbers + 2 Excellon (`PTH`/`NPTH`) drill files + BOM + pick-and-place CSVs bundled into `<project>-fab.zip` and verified via `@tracespace/core`, plus KiCad 9 `.kicad_pcb` export and `.kicad_mod` import.
- **MCP token benchmark (`npm run bench`):**

```text
tools 12 · schema ≈1296 tok
PASS led: 5V LED, prove I < 20 mA                                calls 5  in ≈84  out ≈56  total ≈140 tok
PASS counter: 2-bit counter, verify sequence                     calls 4  in ≈138  out ≈141  total ≈279 tok
PASS layout: place the LED circuit on both views and look at it  calls 4  in ≈68  out ≈53  total ≈121 tok  img ≈256
PASS blink: write the sketch, run it, verify the period          calls 2  in ≈93  out ≈48  total ≈141 tok
```

## Open items

- The fab-house upload is still pending (the user does it by hand).
- Oval drills and non-90° pad rotations from KiCad `.kicad_mod`.
- Freerouting add-on (Specctra DSN/SES).
- Copper pours/zones.
- Resistors default to the `0805` SMD footprint (consider `THT-axial` as the default for hobby boards).
- The UI bundle size warning.
