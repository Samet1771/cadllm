# CadLLM

> Working name. An AI-first, open-source breadboard, schematic and PCB designer and circuit simulator.

AI agents drive it over MCP with very few tokens: build circuits, simulate them and test them, headless. Humans get a breadboard / schematic / PCB UI on the same engine.

**Status:** M4 (analog/SPICE, Arduino/avr8js, mixed-signal co-sim, PCB layout/autorouting/DRC/Gerber/KiCad, live UI, sandboxed plugins & registry), pre-alpha. See [docs/FOUNDATION.md](docs/FOUNDATION.md) for the design.

## Development

Requires Node.js 24 or later. For Arduino sketches, also install `arduino-cli` and the AVR core (set `CADLLM_ARDUINO_CLI` to override the binary path):

```sh
winget install ArduinoSA.CLI
arduino-cli core install arduino:avr
```

```sh
npm install
npm run check      # typecheck + tests
npm run bench      # MCP token benchmark
node packages/cli/src/main.ts test examples/nand-led.cnl
node packages/cli/src/main.ts test examples/blink.cnl
node packages/cli/src/main.ts test examples/button-led.cnl
```

### Web UI & live co-editing

Build the browser UI once, then start `cadllm serve`:

```sh
npm run build -w @cadllm/ui
node packages/cli/src/main.ts serve [file.cnl]
```

Open http://127.0.0.1:5170 in a browser.

Use it from an MCP client (Claude Code shown):

```sh
claude mcp add cadllm -- node /path/to/CadLLm/packages/cli/src/main.ts mcp
```

When `cadllm serve` is running, the registered `cadllm` MCP server automatically attaches to it so AI edits and browser edits share one workspace live (pass `--standalone` for an isolated stdio session).

### PCB layout, autorouting & fabrication export

Over MCP (or in the Web UI's **PCB** tab):

- `layout view=pcb` auto-places footprints inside the board outline (`board 30x20`).
- `layout view=pcb op=route` runs the 2-layer (`F`/`B`) A* autorouter with vias and rip-up.
- `check` runs ERC + PCB DRC (clearance, shorts, courtyard overlap, board edge, track width, drill size, unrouted nets).
- `export format=fab` writes RS-274X X2 Gerbers, Excellon `PTH`/`NPTH` drill files, BOM, and pick-and-place CSVs into `<project>-fab.zip` (also supports `gerber`, `drill`, `kicad`, `bom`, `pnp`, `svg`).

To generate the fabrication zip plus per-layer and top/bottom PNG previews for upload to a fab viewer:

```sh
node packages/export/scripts/fab-preview.ts examples/led-pcb.cnl fab-out/led-pcb
```

### Plugins

List and install signed plugins from the local dev index via the CLI (or the Web UI's **Plugins** manager):

```sh
node packages/cli/src/main.ts plugin search
node packages/cli/src/main.ts plugin install org.cadllm.example-sensors --yes-grant
```

Installed plugin tools are exposed over MCP via `ext` (`ext op=list`, `ext op=call name=calc_divider args={"vin":5,"vout":3.3}`), while AI clients cannot install plugins or grant permissions. Plugins that use only `@cadllm/plugin-api` may use any license (see [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)); see [plugins/example-sensors/](plugins/example-sensors/) as a template.

## License

GPL-3.0-or-later with the [CadLLM plugin exception](LICENSE-EXCEPTION.md). Plugins that use only the public plugin API may use any license.
Contributions are accepted under the [DCO](https://developercertificate.org/) (`git commit -s`).
