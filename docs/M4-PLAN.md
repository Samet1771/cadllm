# M4 Plan: Plugins (plugin runtime, sandbox, `ext`, registry index, first external plugin, UI)

Goal (FOUNDATION §11): **a third-party part pack + MCP tool are installed from the registry index** and used by an AI over MCP (`find`, `ext`, `sim dc`, `check`), with code plugins isolated in a Node 24 permission sandbox + preloaded network guard.

## Decisions (recorded in WP0)
1. **Sandbox for code plugins in Node:** one child process per code plugin started as `node --permission` with only `--allow-fs-read=<plugin dir>` (+ the runtime's own bootstrap/API files) and any extra `fs:read:<path>` / `fs:write:<path>` grants the user approved; **no** `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`. Verified on Node 24.19: filesystem read/write outside the grant, `child_process`, `worker_threads`, `process.dlopen`, and `process.binding(...)` are all denied by Node. **Network is NOT blocked by Node's permission model** (TCP connect/listen still work under `--permission`), so the runtime preloads a guard via `--import <NETWORK_GUARD_PATH>` (`packages/plugins/src/guard.mjs`) that, before plugin code loads, replaces/wraps `node:net`, `node:tls`, `node:dgram`, `node:http`, `node:https`, `node:http2`, `node:dns` (`dns` + `dns/promises`), and global `fetch`, `WebSocket`, and `EventSource` so only hosts granted via manifest `net:<host>` permissions (passed via env `CADLLM_ALLOWED_HOSTS`) are reachable (deny everything by default). Network isolation is a JS-level guard (best effort; raw native bindings are blocked by `--permission`), whereas filesystem and process isolation are enforced by Node's C++ permission model. In the browser, code plugins will run in a Web Worker (later; out of M4 scope beyond UI panels).
2. **Capability RPC:** JSON-RPC 2.0 over the child's stdin/stdout (newline-delimited). The plugin gets only a `cadllm` capability API object (`CadllmPluginApi`) from `@cadllm/plugin-api` (no engine internals):
   - `project.read(opts)` (requires `project:read` grant)
   - `project.edit(cnl, opts)` (requires `project:write` grant; attributed `source: 'plugin'`)
   - `parts.get(id)` / `parts.search(q, limit)`
   - `log(level, message)`
   - Handlers registered via `definePlugin({ tools, checks, activate })` + `connect()`.
   Every host→plugin RPC call has a timeout (default 5 s) and an output size cap (default 1 MiB); a crashing or timed-out plugin child is killed, restarted lazily on the next call, and never takes the engine down.
3. **Contribution points in M4:**
   - `parts`: data (`*.json` in `contributes.parts` folder), validated with `validatePart` and merged into the library. **Conflict namespacing rule:** built-in parts always keep their bare `id`; plugins are merged in lexicographical `manifest.id` order; a plugin part keeps its bare `id` (e.g. `ldr`, `ntc_10k`) if not already taken by a built-in part or an earlier plugin, otherwise it is namespaced as `<pluginId>:<partId>` (e.g. `org.example.sensors:res`). Both `<pluginId>:<partId>` and `<pluginId>/<partId>` always resolve as aliases in `library.get()`.
   - `models` of `kind: 'spice'`: data (`.subckt` or `.model` SPICE text from `file`/`main` or inline `spice`, referenced by `part.sim` `{ kind: 'spice', ref }` and consumed by `@cadllm/sim-spice`).
   - `tools`: code, exposed lazily through MCP `ext` (tool names keep their bare `name` unless colliding with an earlier plugin tool, in which case `<pluginId>:<toolName>`; `<pluginId>:<toolName>` and `<pluginId>/<toolName>` always resolve in `callTool`).
   - `checks`: code, run during `check` and returned with messages tagged `[<pluginId>] <message>`.
   - `panels`: UI sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`), WP4.
   - **Deferred:** JS digital models (`kind: 'digital'`) are rejected during manifest validation with a clear message (`cross-process call per logic event is too slow`).
4. **MCP (12 tools):**
   - `part` is folded into `find` (`find { q?, id?, limit? }`): passing `id` describes one or more parts (`"led,74hc00"`) identically to how `part` did; passing `q` searches the library.
   - Added `ext { op: 'list' | 'call', name?, args? }`: `ext list` prints one line per installed plugin tool (`<name>  <summary>  (<plugin>@<version>)`), `ext call` invokes it.
   - **Security invariant:** an AI can **never** install plugins, remove plugins, or grant permissions over MCP. Install/grant/remove happen only through the CLI (`cadllm plugin …`) or the UI. Pinned top-level plugin MCP tools are out of scope for M4.
5. **Registry:**
   - Static `index.json` (local folder `registry/` in this repo + `file:` and `https:` URLs supported).
   - Format: `{ version: 1, keys: { publishers: { [publisher]: pubKey }, signature }, plugins: [{ id, name, summary, publisher, license?, versions: [{ version, engine, url, sha256, size, permissions, contributes, signature }] }] }`.
   - Packages are `.cnlplugin` deterministic zip archives (`fflate`).
   - Integrity & authenticity: `sha256` and `size` must match the downloaded archive; signatures are **ed25519** (`node:crypto`, zero extra dependencies) over canonical JSON (sorted keys, no whitespace); `keys.publishers` is signed by the registry private key; each version entry (`id` + version fields minus `signature`) is signed by the publisher's private key.
   - The CLI trusts the registry public key configured in `~/.cadllm/config.json` (`registryPublicKey`, defaulting to the repo's `registry/registry.pub`).
   - Installs extract to `~/.cadllm/plugins/<id>/<version>/` (override env `CADLLM_STATE_DIR`) with zip-slip path traversal protection, `satisfiesEngine(manifest.engine)` check against `PLUGIN_API_VERSION` (`1.0.0-alpha.0`), and explicit permission grant recorded in `~/.cadllm/grants.json`.
6. **Public API package (`@cadllm/plugin-api`):**
   - Version `1.0.0-alpha.0`. Covered by `LICENSE-EXCEPTION.md` (plugins depending only on `@cadllm/plugin-api` may use any license, noted in `packages/plugin-api/README.md`).
   - Exports `PLUGIN_API_VERSION`, `ManifestSchema`, `validateManifest`, `checkManifest`, `contributedKinds`, `satisfiesEngine`, `parseSemver`, `isValidSemverRange`, contribution/part/RPC types, `definePlugin`, and `connect`.

## Status

| Piece | State | Summary |
|---|---|---|
| WP0 `@cadllm/plugin-api`, `@cadllm/plugins` & `@cadllm/registry` contracts, Engine/Workspace/sim-spice/MCP wiring, CLI skeleton, `M4-PLAN.md` | ✅ | `@cadllm/plugin-api` (`1.0.0-alpha.0`) + tests; `find` (`q`/`id`) + `ext` (12 tools); Engine/Workspace/sim-spice plugin integration; CLI `cadllm plugin` skeleton. |
| WP1 `@cadllm/plugins` host runtime, Node `--permission` sandbox, `guard.mjs`, JSON-RPC stdio, escape tests | ✅ | `@cadllm/plugins` host. Each code plugin runs in its own `node --permission` process: fs limited to the plugin dir, no child processes, workers or addons, raw bindings blocked. A preloaded `guard.mjs` denies all network except granted `net:<host>[:port]` and never allows listening. JSON-RPC over stdio with a 5 s timeout and a 1 MB output cap; a crashed plugin restarts lazily and is marked failed after 3 crashes. An escape suite covers 20+ attack categories, all denied. Cold spawn ≈130 ms, warm call ≈0.2 ms. |
| WP2 `@cadllm/registry` index, ed25519 signing, `.cnlplugin` pack/install, CLI `cadllm plugin …`, `registry/` keys | ✅ | `@cadllm/registry` + `cadllm plugin search\|install\|list\|remove\|grant\|revoke\|pack\|sign\|keygen`. Deterministic `.cnlplugin` zips, ed25519 signatures (a registry key signs the index and publisher keys; publishers sign entries), tests reject tampering and zip-slip, installs are atomic, and installing never grants permissions. |
| WP3 `plugins/example-sensors/` (`ldr`, `ntc_10k`, SPICE models, `calc_divider`, `led_no_resistor`), published in `registry/`, E2E test | ✅ | `plugins/example-sensors` (MIT): `ldr`/`ntc10k` parts with SPICE models, the `calc_divider` tool, the `led_no_resistor` check and a Sensor calculator panel. Published in `registry/`. The end-to-end test installs from the index and uses everything over MCP. |
| WP4 `@cadllm/ui` plugins manager, permission review dialog, sandboxed iframe `panels` host, `ws.ts` plugin RPCs | ✅ | a UI Plugins manager with a permission review where every box starts unchecked, grant/revoke and uninstall; sandboxed iframe panels with a strict CSP, a validated postMessage API and user-confirmed edits; the server's `plugins.*` methods are UI-only and absent from MCP. |

## Measured

`npm run bench`:
```text
tools 12 · schema ≈1326 tok
PASS led: 5V LED, prove I < 20 mA                                calls 5  in ≈84  out ≈56  total ≈140 tok
PASS counter: 2-bit counter, verify sequence                     calls 4  in ≈138  out ≈141  total ≈279 tok
PASS layout: place the LED circuit on both views and look at it  calls 4  in ≈68  out ≈53  total ≈121 tok  img ≈256
PASS blink: write the sketch, run it, verify the period          calls 2  in ≈93  out ≈48  total ≈141 tok
PASS plugin: discover and call a plugin tool                     calls 2  in ≈33  out ≈41  total ≈74 tok
```

## Open items

- JS digital sim models from plugins are deferred: a cross-process call per logic event is too slow, so this needs an in-process sandbox (QuickJS/WASM) or batching.
- Code plugins run in Node only; Web Worker execution in the browser is not built yet.
- Network isolation is a JS-level guard, not OS-level (fs and process isolation are enforced by Node).
- The dev registry's private keys are committed on purpose. Rotate to a production registry key kept out of git before publishing.
- Pinned top-level plugin tools.
- The registry is not hosted online yet (M5: GitHub Pages).

## Ground rules (in addition to M0–M3)
- **Read first:** `docs/FOUNDATION.md` (§4, §7, §9, §11), `LICENSE-EXCEPTION.md`, this file, and the WP0 contracts (`packages/plugin-api/src/index.ts`, `packages/plugins/src/index.ts`, `packages/registry/src/index.ts`, `packages/engine/src/{engine,workspace}.ts`, `packages/mcp/src/server.ts`).
- **Own only your folder:**
  - **WP0:** `packages/plugin-api/` (frozen after WP0 except additive), `packages/engine/`, `packages/mcp/`, `packages/sim-spice/`.
  - **WP1:** `packages/plugins/`
  - **WP2:** `packages/registry/`, `registry/`, `packages/cli/src/plugin*.ts`, `packages/cli/test/plugin*.ts`
  - **WP3:** `plugins/example-sensors/` (and publishing its package/entry into `registry/`)
  - **WP4:** `packages/ui/`, `packages/server/src/ws.ts` (plugin WebSocket methods only; plus `packages/server/src/server.ts` static/panel route if needed for iframe assets)
- **No `npm install` for WP1–WP4.** All dependencies (`zod`, `fflate`, `node:crypto`) are already installed and workspaces include `plugins/*`.
- **Node 24 erasable TypeScript:** no `enum`, `namespace`, or constructor parameter properties; `.ts` import extensions; SPDX header (`GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception`) on every CadLLM source file (and `MIT` on `plugins/example-sensors/`).
- **Deterministic output:** sorted keys/entries, fixed zip mtime (`new Date(1980, 0, 1, 0, 0, 0)`), no wall-clock timestamps or randomness in output.
- **Done when:** `npm run check` passes at the repo root (WP4: plus `npm run typecheck -w @cadllm/ui` and `npm run build -w @cadllm/ui`).

## Shared conventions
- **State directory:** `resolveStateDir(override)` uses `override ?? process.env.CADLLM_STATE_DIR ?? join(homedir(), '.cadllm')`.
  - Installed plugins: `<stateDir>/plugins/<id>/<version>/`
  - Permission grants: `<stateDir>/grants.json` (`{ "<pluginId>": ["project:read", ...] }`, sorted keys and permissions)
  - Config: `<stateDir>/config.json` (`{ "registryUrl"?: string, "registryPublicKey"?: string }`)
- **Part ID conflict namespacing:**
  - Built-in parts (`builtinPartIds`) keep their bare `id`.
  - Loaded plugins are ordered by `manifest.id` (`a.localeCompare(b)`).
  - If a plugin part's `id` is not in `builtinPartIds` and not already claimed by an earlier plugin, its `PartDef.id` stays bare (e.g. `ldr`, `ntc_10k`).
  - If it collides, `PluginHost.parts()` returns a copy with `id: "${manifest.id}:${part.id}"`. Both `${manifest.id}:${part.id}` and `${manifest.id}/${part.id}` resolve in `Workspace.library.get()`.
- **SPICE models (`contributes.models` with `kind: 'spice'`):**
  - Each model has `{ id, kind: 'spice', file?: string, main?: string, spice?: string }`.
  - `PluginHost.spiceModels()` returns a `Map<string, string>` mapping `model.id` → SPICE `.subckt` or `.model` text.
  - For subcircuits (`.subckt <ID> <pin1> <pin2> ... [param=default ...]`), `@cadllm/sim-spice` maps `part.pins` in order to SPICE nodes and passes numeric component properties referenced in the subcircuit as `key=value` parameters on the `X<ref>` instance line.
- **Capability RPC protocol (JSON-RPC 2.0 over newline-delimited stdio):**
  - Host → Plugin requests:
    - `plugin/activate` `{}` → `{ ok: true }`
    - `tool/call` `{ name: string, args: Record<string, unknown> }` → `string`
    - `check/run` `{ id?: string }` → `PluginIssue[]`
  - Plugin → Host requests/notifications:
    - `project/read` `ProjectReadOptions` → `string` (host verifies `project:read` is in plugin grants; denies with JSON-RPC error `-32001` `"permission denied: project:read"` if not granted)
    - `project/edit` `{ cnl: string, dry_run?: boolean, if_rev?: number }` → `string` (host verifies `project:write` is in plugin grants; executes edit with `source: 'plugin'`)
    - `parts/get` `{ id: string }` → `PartDef | undefined`
    - `parts/search` `{ q: string, limit?: number }` → `PartDef[]`
    - `log` notification `{ level: 'info' | 'warn' | 'error', message: string }`
- **Canonical JSON for ed25519 signatures:**
  - Recursively sort object keys lexicographically (`Object.keys(obj).sort()`) and serialize with `JSON.stringify` (no whitespace).
  - `keys.signature` signs canonical `{ publishers: index.keys.publishers }`.
  - Each `RegistryVersionEntry.signature` signs canonical `{ id: plugin.id, version, engine, url, sha256, size, permissions, contributes }` using the publisher's ed25519 private key.
  - Public/private keys are stored as PEM (`PUBLIC KEY` SPKI / `PRIVATE KEY` PKCS#8) or base64 DER strings supported by `node:crypto` `createPublicKey` / `createPrivateKey` and `sign(null, data, privKey)` / `verify(null, data, pubKey, sig)`.

---

## WP1 `packages/plugins/`: host runtime, sandbox, network guard, RPC, escape tests (tier: hardest)
- **`sandboxArgs(manifest, grants, opts)`:**
  - Always include `'--permission'`.
  - Compute allowed fs-read paths: `opts.pluginDir` (resolved), `packages/plugin-api` directory, `NETWORK_GUARD_PATH`, and any `opts.bootstrapFiles` plus any `fs:read:<path>` in `grants` (only if also requested in `manifest.permissions`). Pass `--allow-fs-read=<path>` for each.
  - For any `fs:write:<path>` in `grants` (intersected with `manifest.permissions`), pass `--allow-fs-write=<path>`.
  - Never include `--allow-child-process`, `--allow-worker`, `--allow-addons`, or `--allow-wasi`.
  - Always include `'--import', NETWORK_GUARD_PATH` (or `pathToFileURL(NETWORK_GUARD_PATH).href`).
- **`packages/plugins/src/guard.mjs` (`NETWORK_GUARD_PATH`):**
  - Read granted hosts from `process.env.CADLLM_ALLOWED_HOSTS` (comma-separated lowercase `host` or `host:port` derived from granted `net:<host>` permissions; immediately delete `process.env.CADLLM_ALLOWED_HOSTS` or freeze it so plugin code cannot mutate the allowlist).
  - Deny all network access by default with an `Error` (`code = 'ERR_NETWORK_ACCESS_DENIED'`, message `'Network access to "<host>" denied by CadLLM sandbox'`).
  - Wrap/patch before plugin code loads:
    - `node:net` (`Socket.prototype.connect`, `connect`, `createConnection`, `Server.prototype.listen`, `createServer` — block `listen` unless host is explicitly granted, check target `host`/`port` on `connect`)
    - `node:tls` (`connect`, `createServer`)
    - `node:dgram` (`createSocket` `send`/`bind`/`connect` — block UDP completely unless granted)
    - `node:http`, `node:https`, `node:http2` (`request`, `get`, `connect`)
    - `node:dns` and `node:dns/promises` (`lookup`, `resolve*`, `Resolver` methods — allow only hosts in the allowlist)
    - `globalThis.fetch`, `globalThis.WebSocket`, `globalThis.EventSource` (parse URL hostname/host and verify against allowlist before delegating).
  - Use `node:module` `registerHooks` or module export patching + prototype patching so both `import net from 'node:net'` and `createRequire` see the guarded implementations.
- **`PluginHost` (`packages/plugins/src/index.ts`):**
  - Maintain a monotonic `revision: number` property (via `this.bumpRevision()`), incremented whenever plugins are loaded (`load`), unloaded (`unload`), or disposed (`dispose`). `Workspace.library` caches the merged `Library` by `(plugins, plugins.revision)` and returns the base library directly with zero overhead when no plugins are loaded.
  - `load(dir, opts?)`: read and validate `<dir>/plugin.json` via `validateManifest`; intersect effective grants (`opts?.grants` ?? `this.opts.grants` lookup ?? `[]`) with `manifest.permissions`; load `contributes.parts` (`*.json` recursively, validated via `validatePart` from `@cadllm/library`); load `contributes.models` (`kind: 'spice'` from `file`/`main` or inline `spice`); register `tools`, `checks`, `panels`; call `this.bumpRevision()`.
  - Lazy child process management: spawn `process.execPath` with `[...sandboxArgs(manifest, grants, { pluginDir: dir, bootstrapFiles }), entryPath]` and `env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, CADLLM_ALLOWED_HOSTS: allowedHosts.join(',') }` (strip sensitive ambient env vars).
  - Run `plugin/activate` once on first spawn; route `tool/call` and `check/run` over newline-delimited JSON-RPC 2.0 on child `stdin`/`stdout`.
  - Enforce `project:read` on `project/read` and `project:write` on `project/edit`; attribute plugin edits with `source: 'plugin'`.
  - Enforce per-call timeout (`timeoutMs`, default 5000 ms) and max stdout buffer/line size (`maxOutputBytes`, default 1 MiB): on timeout, oversized output, or crash, kill the child process (`SIGKILL`), reject the active call with a clear `CadError`, and mark the child dead so the next call lazily spawns a fresh process without crashing the engine.
  - `runChecks(q, ctx?)`: invoke all contributed checks across loaded plugins in deterministic plugin order, returning `PluginCheckIssue[]` tagged with `pluginId`.
  - `dispose()`: kill all running plugin child processes and wait for exit.
- **Escape & integration tests (`packages/plugins/test/`):**
  - Hostile fixture plugin that attempts:
    1. `fs.readFileSync` outside its plugin directory → denied (`ERR_ACCESS_DENIED`)
    2. `fs.writeFileSync` inside and outside its plugin directory → denied (`ERR_ACCESS_DENIED`)
    3. `child_process.spawn` / `execSync` → denied (`ERR_ACCESS_DENIED`)
    4. `new worker_threads.Worker(...)` → denied (`ERR_ACCESS_DENIED`)
    5. `process.dlopen` → denied
    6. `process.binding('fs')` / `process.binding('tcp_wrap')` → denied
    7. Raw `net.connect` to an ungranted host → denied (`ERR_NETWORK_ACCESS_DENIED`)
    8. `fetch` to an ungranted host → denied
    9. `dns.lookup` / `dns.promises.lookup` to an ungranted host → denied
    10. `http.get` to an ungranted host → denied
    11. Infinite loop (`while (true) {}`) → killed on timeout, subsequent call to another tool or after restart recovers cleanly
    12. Huge stdout output (`'x'.repeat(5_000_000)`) → killed on output limit, engine stays alive
  - Positive network grant test: spin up a local HTTP server on `127.0.0.1:<ephemeral>`, load a plugin declaring and granted `net:127.0.0.1`, verify `fetch('http://127.0.0.1:<port>/ping')` succeeds inside the plugin while `fetch('http://localhost:<port>/ping')` (ungranted hostname) is blocked.
  - Engine integration test: parts conflict namespacing (`<pluginId>:<partId>`), SPICE model in `dc`, `ext list` / `ext call`, `project.read` / `project.edit` (verified `source === 'plugin'` in `history log`, denied without `project:write`), and `check` output tagged with `[<pluginId>]`.

---

## WP2 `packages/registry/`, `registry/`, `packages/cli/src/plugin*.ts`: registry, signing, packaging, CLI (tier: hard)
- **`packages/registry/`:**
  - `keygen()`: generate an Ed25519 keypair via `generateKeyPairSync('ed25519')` returning PEM strings `{ publicKey, privateKey }`.
  - `sign(payload, privateKey)` and `verifySignature(payload, signature, publicKey)`: Ed25519 signing/verification over canonical JSON (sorted keys) or raw `Uint8Array` / string, returning base64 signature.
  - `pack(dir)`: validate `<dir>/plugin.json` via `validateManifest`, walk plugin files deterministically (excluding `node_modules`, `.git`, `*.cnlplugin`), and bundle into a deterministic `.cnlplugin` zip (`fflate.zipSync` with fixed mtime `1980-01-01`).
  - `loadIndex(urlOrPath?)`: load `index.json` from a local directory (`<dir>/index.json`), a local file path, a `file://` URL, or an `https://` / `http://` URL (`fetch`). Default when omitted: `config.json`'s `registryUrl` or the repo's `registry/index.json`. Attach `baseUrl` for resolving relative `version.url` paths.
  - `verifyIndex(index, registryPublicKey?)`: verify `index.keys.signature` against `registryPublicKey` (defaulting to `~/.cadllm/config.json` or repo `registry/registry.pub`), then verify every plugin version's `signature` against `index.keys.publishers[plugin.publisher]`. Throw a clear error on any mismatch.
  - `resolve(index, id, range = '*', engineVersion = PLUGIN_API_VERSION)`: pick the highest semver version of plugin `id` that satisfies `range` AND whose `version.engine` satisfies `engineVersion`. Throw a clear error if the plugin is missing or no version matches.
  - `install(entry, opts)`:
    - Verify signature (when `opts.index` or `opts.publisherPublicKey` provided).
    - Check `satisfiesEngine(version.engine, opts.engineVersion)`.
    - Fetch or read `.cnlplugin` bytes from `version.url` (resolved against `baseUrl`).
    - Verify `bytes.byteLength === version.size` and `sha256(bytes) === version.sha256`.
    - Unzip with `fflate.unzipSync`, rejecting any entry path with `..`, leading `/` or `\`, or Windows drive letters (**zip-slip protection**).
    - Validate extracted `plugin.json` with `validateManifest` and verify `id`, `version`, `permissions`, and `engine` match the index entry.
    - Check permission grants: if the plugin requests permissions, either use `opts.grant` (`true` = all, `PluginPermission[]` = subset), call `opts.approvePermissions(manifest.permissions, manifest)`, or throw if unapproved.
    - Write files to `<stateDir>/plugins/<id>/<version>/` and save granted permissions in `<stateDir>/grants.json`.
  - `uninstall(id, opts)`, `listInstalled(opts)`, `getGrants(id, opts)`, `setGrants(id, permissions, opts)`.
- **`registry/` folder in repo:**
  - Generate and commit a development/test registry keypair (`registry/registry.pub` and `registry/registry.key` clearly marked `DEV/TEST ONLY — DO NOT USE IN PRODUCTION`) and publisher keypair (`registry/example-publisher.pub`, `registry/example-publisher.key`), plus `registry/README.md` documenting key rotation for production and how `index.json` is signed.
  - Initialize `registry/index.json` signed with `registry/registry.key`.
- **CLI (`packages/cli/src/plugin.ts`):**
  - Implement `cadllm plugin search|install|list|remove|grant|pack|sign|keygen`.
  - `cadllm plugin install <id[@range]> [--index <url|dir>] [--grant <p1,p2>|--yes]` prompts or uses `--grant`/`--yes` (non-TTY without `--grant`/`--yes` refuses if permissions are requested, printing the required permissions and the `--grant` flag to approve).
- **Tests (`packages/registry/test/` & `packages/cli/test/plugin.test.ts`):**
  - Ed25519 `keygen` → `sign` → `verifyIndex` round-trip.
  - Tampered `sha256`, tampered `signature`, untrusted publisher key, untrusted registry key, and incompatible `engine` range are all rejected.
  - Zip-slip archive containing `../evil.txt` or `/abs/evil.txt` is rejected before writing any file.
  - CLI commands `keygen`, `pack`, `sign`, `search`, `install --yes`, `list`, `grant`, `remove` tested against a temp `CADLLM_STATE_DIR`.

---

## WP3 `plugins/example-sensors/`: first external plugin + registry publication + E2E test (tier: standard)
- **Package layout (`plugins/example-sensors/`):**
  - `package.json`: `"name": "cadllm-plugin-example-sensors"`, `"version": "1.0.0"`, `"license": "MIT"`, `"type": "module"`, depends **only** on `"@cadllm/plugin-api": "*"`.
  - `LICENSE`: standard MIT license text (`SPDX-License-Identifier: MIT` on source files).
  - `plugin.json`:
    - `id`: `"org.example.sensors"`
    - `name`: `"Example Sensor Pack"`
    - `version`: `"1.0.0"`
    - `summary`: `"LDR photoresistor, NTC 10k thermistor, voltage divider solver, and LED resistor check"`
    - `publisher`: `"example"`
    - `engine`: `"^1.0.0"`
    - `license`: `"MIT"`
    - `main`: `"src/index.ts"`
    - `permissions`: `["project:read"]`
    - `contributes`:
      - `parts`: `"parts"`
      - `models`: `[{ "id": "LDR", "kind": "spice", "file": "models/ldr.cir" }, { "id": "NTC_10K", "kind": "spice", "file": "models/ntc_10k.cir" }]`
      - `tools`: `[{ "name": "calc_divider", "summary": "solve resistor divider for Vin/Vout (E12/E24)" }]`
      - `checks`: `[{ "id": "led_no_resistor", "summary": "warn when an LED is directly across a voltage source without a series resistor" }]`
      - `panels`: `[{ "id": "sensors", "title": "Sensor Calculator", "main": "panel/index.html" }]` (simple self-contained HTML panel so WP4 can also render/test it)
- **Parts & SPICE models:**
  - `parts/ldr.json`: `id: "ldr"`, `name: "LDR Photoresistor"`, `category: "sensor"`, `refPrefix: "R"`, 2 passive pins (`1`, `2`), `props: { lux: { type: "number", unit: "lx", default: "100", description: "Illuminance in lux" } }`, `valueProp: "lux"`, `sim: [{ kind: "spice", ref: "LDR" }]`, `footprints: ["THT-axial"]`, `views: { sch: "resistor", bb: "axial" }`.
  - `models/ldr.cir`: `.subckt LDR 1 2 lux=100` modeling photoresistor resistance vs. lux (e.g. $R(\text{lux}) = 10\,\text{k}\Omega \cdot (100 / \max(1, \text{lux}))^{0.7}$, so at `100` lux $R = 10\,\text{k}\Omega$, at `1000` lux $R \approx 2\,\text{k}\Omega$).
  - `parts/ntc_10k.json`: `id: "ntc_10k"`, `name: "NTC 10k Thermistor"`, `category: "sensor"`, `refPrefix: "R"`, 2 passive pins (`1`, `2`), `props: { temp: { type: "number", unit: "C", default: "25", description: "Temperature in °C" } }`, `valueProp: "temp"`, `sim: [{ kind: "spice", ref: "NTC_10K" }]`, `footprints: ["THT-axial"]`, `views: { sch: "resistor", bb: "axial" }`.
  - `models/ntc_10k.cir`: `.subckt NTC_10K 1 2 temp=25` using standard B-parameter equation $R(T) = 10\,\text{k}\Omega \cdot \exp(3950 \cdot (1/(T + 273.15) - 1/298.15))$.
- **Code contributions (`src/index.ts` using `definePlugin` + `connect` from `@cadllm/plugin-api`):**
  - Tool `calc_divider`: given `{ vin: number, vout: number, series?: 'E12' | 'E24' }` (default `'E24'`, $0 < V_{\text{out}} < V_{\text{in}}$), picks the best standard resistor pair `(R1, R2)` in the `1k..100k` decade range minimizing $|V_{\text{in}} \cdot R_2 / (R_1 + R_2) - V_{\text{out}}|$, and returns compact text: `R1=<val> R2=<val> Vout=<actual>V err=<pct>%`.
  - Check `led_no_resistor`: reads the current project via `cadllm.project.read({ detail: 1 })`, parses component and net lines, and warns (`level: 'warn'`, `at: [ledRef]`) whenever an `led` component has its anode and cathode connected directly across two nets driven by a voltage source (`battery`, `dc_supply`, `vcc_symbol`) and ground (`gnd_symbol`, `GND`, or source `-`) with no series resistor.
- **Registry publication:**
  - Pack `plugins/example-sensors/` into `registry/packages/org.example.sensors-1.0.0.cnlplugin`, sign with `registry/example-publisher.key` and `registry/registry.key`, and commit the updated `registry/index.json` + `.cnlplugin` file.
- **End-to-end test (`plugins/example-sensors/test/e2e.test.ts`):**
  - Load `registry/index.json` → `verifyIndex` → `resolve('org.example.sensors')` → `install` into a temp `CADLLM_STATE_DIR` with grants → load installed plugin into `PluginHost` + `Engine` + MCP `Client`/`Server` → MCP `find q="ldr"` sees `ldr` and `find id="ldr"` prints `lux` prop → MCP `ext op="list"` lists `calc_divider` and `ext op="call" name="calc_divider" args={ vin: 5, vout: 3.3 }` returns the divider pair → MCP `edit` builds a 5 V + 10k + `ldr` divider and `sim run="dc"` verifies `V(OUT)` changes with `lux=100` vs `lux=1000` (and NTC changes with `temp=25` vs `temp=85`) → MCP `check` flags an LED across 5 V without a resistor tagged `[org.example.sensors]` → `uninstall`.

---

## WP4 `packages/ui/` & `packages/server/src/ws.ts`: plugins panel & sandboxed iframe panels (tier: hard)
- **Server WebSocket RPC additions (`packages/server/src/ws.ts`):**
  - Wire installed plugins from `resolveStateDir()` into `startServer`'s `Workspace` via `PluginHost` (reloading when plugins are installed/granted/removed).
  - Add WebSocket-only JSON-RPC methods (never exposed on MCP `TOOLS`, preserving the security rule that AI cannot install or grant plugins over MCP):
    - `plugins.installed`: returns `InstalledPlugin[]` + active contributed `panels` (including panel HTML content or `/plugin-panel/<pluginId>/<panelId>` route).
    - `plugins.registry`: loads and verifies the configured registry index (`loadIndex` + `verifyIndex`) and returns `RegistryPluginEntry[]`.
    - `plugins.install`: `{ id: string, version?: string, grant: PluginPermission[] }` → installs from the verified index, records grants, loads into `workspace.plugins`, and notifies connected UI clients.
    - `plugins.grant`: `{ id: string, permissions: PluginPermission[] }` → updates `grants.json` and reloads the plugin in `workspace.plugins`.
    - `plugins.uninstall`: `{ id: string }` → unloads from `workspace.plugins` and removes from disk.
- **UI Plugins Manager (`packages/ui/`):**
  - **Plugins** button/drawer or bottom/side tab showing:
    - **Installed tab:** installed plugins (`name`, `id@version`, `license`, contributed badges, current granted permissions with toggle checkboxes to grant/revoke, and **Uninstall** button).
    - **Browse Registry tab:** search/list entries from `plugins.registry`, showing publisher, summary, version, license, and **Install…** button.
    - **Permission Review Dialog:** before completing install, shows requested permissions (`project:read`, `project:write`, `net:<host>`, `fs:...`) with clear human descriptions and checkboxes so the user explicitly approves or cancels.
- **Sandboxed iframe `panels` host (`packages/ui/`):**
  - Render contributed plugin panels in an `<iframe sandbox="allow-scripts" srcDoc={...} />` (no `allow-same-origin`, so the iframe has an opaque `null` origin and cannot access parent DOM, cookies, or WebSocket).
  - Small `postMessage` bridge between parent UI and panel iframe:
    - Iframe → Host `{ type: 'cadllm:project.read', id, opts? }` → Host replies `{ type: 'cadllm:response', id, result: cnlText }`.
    - Iframe → Host `{ type: 'cadllm:project.edit', id, cnl }` → Host shows a **user confirmation prompt/modal** displaying the proposed CNL edit diff/lines; only if the user clicks **Apply** does the UI execute `edit` and reply `{ type: 'cadllm:response', id, result }`.
  - Include a working demo panel in `plugins/example-sensors/panel/index.html` (and in `?demo` mode) that reads the circuit and proposes a resistor-divider edit on user click.
- **Tests:** unit tests for permission review state, postMessage bridge (verifying `project.edit` requires user confirmation and rejects unconfirmed edits), and WebSocket `plugins.*` RPC methods; keep `npm run typecheck -w @cadllm/ui`, `npm run build -w @cadllm/ui`, and `npm run check` green.
