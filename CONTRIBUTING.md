# Contributing to CadLLM

Thank you for contributing to CadLLM! CadLLM is an AI-first, open-source breadboard, schematic, and PCB designer and circuit simulator.

## 1. Developer Certificate of Origin (DCO)

All contributions are accepted under the [Developer Certificate of Origin (DCO) v1.1](https://developercertificate.org/). We do not require a separate CLA.

Every commit must carry a `Signed-off-by` trailer matching the commit author (`git commit -s`):

```sh
git commit -s -m "feat(dsl): describe your change"
```

This adds:

```text
Signed-off-by: Your Name <your.email@example.com>
```

By signing off, you certify that you have the right to submit the contribution under the project's license (`GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception`).

## 2. Pre-PR Verification Checklist

Before opening a pull request, run the verification suite locally on **Node.js 24+**:

```sh
npm run check                  # Root TypeScript typecheck + full Vitest suite
npm run typecheck -w @cadllm/ui
npm run build -w @cadllm/ui
npm run bench                  # MCP token benchmark (verifies schema & call token budgets)
npm run site                   # Builds static Pages site & verifies registry signatures
```

For tests that compile Arduino sketches (`@cadllm/sim-mcu` and `@cadllm/sim-mixed`), install `arduino-cli` and the AVR core (`arduino-cli core install arduino:avr`).

## 3. Coding Conventions

- **Native Node 24 TypeScript:** Packages run directly from `.ts` source files with Node 24's built-in type stripping (`erasableSyntaxOnly: true`).
  - Do **not** use `enum`, `namespace`, or constructor parameter properties.
  - Always use explicit `.ts` (or `.tsx` in `@cadllm/ui`) extensions in relative imports.
- **SPDX License Headers:** Every source file in the repository must start with:
  ```ts
  // SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
  ```
- **Determinism:** Simulation traces, CNL serialization, SVG renders, Gerber/Excellon exports, and `.cnlplugin` archives must be deterministic (sorted keys, stable formatting, no wall-clock timestamps or unseeded randomness).
- **Token-Cheap MCP Surface:** The 12-tool MCP surface is the primary interface. Any change affecting MCP tool schemas or responses must keep `npm run bench` within token budgets.

## 4. Licensing & Plugin Exception Note

CadLLM is licensed under **GPL-3.0-or-later** with the **CadLLM Plugin Exception** ([LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md), SPDX `LicenseRef-CadLLM-plugin-exception`).

> [!IMPORTANT]
> **Delegated-Review Note:** The CadLLM Plugin Exception in [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md) is currently a **draft pending qualified legal review** before the first public release (modeled on the GCC Runtime Library Exception and the Classpath Exception).
>
> Because `@cadllm/plugin-api` is both a technical and a legal boundary (allowing plugins that interact with CadLLM **only** through `@cadllm/plugin-api` to use any license), contributors must keep `@cadllm/plugin-api` self-contained and never leak internal engine modules across that boundary.
