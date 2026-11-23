# `@cadllm/desktop`

Windows desktop shell (Electron + NSIS installer) for CadLLM.

## Architecture

- **Main process (`src/main.ts` -> bundled to `dist/main.mjs` via `rolldown`):**
  - Enforces a single-instance lock (`app.requestSingleInstanceLock()`) and opens `.cnl` files passed via CLI/Windows file association.
  - Starts the CadLLM HTTP, WebSocket (`/ws`), and Streamable HTTP MCP (`/mcp`) server in-process on a free loopback port (`127.0.0.1`), writing `~/.cadllm/serve.json` so `cadllm mcp` attaches automatically and removing `serve.json` on clean quit.
  - Opens a hardened `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `?demo`, strict CSP, loopback-only request/navigation guard).
  - Provides native File > New / Open / Save / Save As dialogs backed by the existing `Engine.project` operations.
  - Runs code plugins in sandboxed child processes via `electron.exe` with `ELECTRON_RUN_AS_NODE=1`, Node `--permission`, and the preloaded network guard (`resources/plugin-runtime/{guard.mjs,plugin-api.mjs}`).

## Scripts

- `npm run dev -w @cadllm/desktop` — build desktop bundles and launch Electron (pass `--vite` to attach to the Vite UI dev server).
- `npm run dist -w @cadllm/desktop` — build `@cadllm/ui`, bundle main/preload/plugin-runtime, and package `release/CadLLM-Setup-<version>.exe`.
- `npm run smoke -w @cadllm/desktop` — headless-ish launch of the packaged app checking `/health`, `/mcp` tool calls, and `serve.json` cleanup.

## Plugin Registry Configuration

By default, the packaged app ships a verified offline copy of the registry (`resources/registry/index.json`, `index.sig`, `registry.pub`, and `packages/*.cnlplugin`) so plugin browsing and installation work without network access or relying on `cwd`.

Users can override the registry index URL or trusted public key in `~/.cadllm/config.json` (or `$CADLLM_STATE_DIR/config.json`), for example to point at the online GitHub Pages registry:

```json
{
  "registryUrl": "https://samet1771.github.io/cadllm/registry/"
}
```

## Open items

- **Code signing:** installer and executable are currently **unsigned** (`signExecutable: false`). Add an Authenticode certificate (`CSC_LINK` / `CSC_KEY_PASSWORD` or Trusted Signing) before public distribution.
- **Application icon:** `build/icon.ico` and `build/icon.png` are generated placeholders (`scripts/icon.ts`); replace with final brand artwork before release.
- **Auto-update / macOS & Linux targets:** deferred past M5.
