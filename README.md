# CadLLM

> Working name. An AI-first, open-source breadboard, schematic and PCB designer and circuit simulator.

AI agents drive it over MCP with very few tokens: build circuits, simulate them and test them, headless. Humans get a breadboard / schematic / PCB UI on the same engine.

**Status:** M0 (engine + MCP), pre-alpha. See [docs/FOUNDATION.md](docs/FOUNDATION.md) for the design.

## Development

Requires Node.js 24 or later.

```sh
npm install
npm run check      # typecheck + tests
```

## License

GPL-3.0-or-later with the [CadLLM plugin exception](LICENSE-EXCEPTION.md). Plugins that use only the public plugin API may use any license.
Contributions are accepted under the [DCO](https://developercertificate.org/) (`git commit -s`).
