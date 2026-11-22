# CadLLM

> Working name. An AI-first, open-source breadboard, schematic and PCB designer and circuit simulator.

AI agents drive it over MCP with very few tokens: build circuits, simulate them and test them, headless. Humans get a breadboard / schematic / PCB UI on the same engine.

**Status:** M2 (analog/SPICE, Arduino/avr8js, mixed-signal co-sim, live UI), pre-alpha. See [docs/FOUNDATION.md](docs/FOUNDATION.md) for the design.

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

## License

GPL-3.0-or-later with the [CadLLM plugin exception](LICENSE-EXCEPTION.md). Plugins that use only the public plugin API may use any license.
Contributions are accepted under the [DCO](https://developercertificate.org/) (`git commit -s`).
