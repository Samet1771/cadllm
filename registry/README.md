# CadLLM Plugin Registry (`registry/`)

> [!IMPORTANT]
> **Production Trust Model:** Only public keys (`registry.pub` and `publishers/*.pub`) are committed to this repository. Maintainer private signing keys live outside the repository in `~/.cadllm/keys/` (`~/.cadllm/keys/registry.pem` and `~/.cadllm/keys/publishers/<id>.pem`) and are never committed.

## Overview & Files

| File | Purpose |
|---|---|
| `registry.pub` | Default trusted Ed25519 root public key (SPKI PEM) for verifying `index.json` / `index.sig` and publisher key bindings. |
| `publishers/cadllm-examples.pub` | Ed25519 public key for the built-in example publisher (`cadllm-examples`). |
| `packages/*.cnlplugin` | Deterministic `.cnlplugin` ZIP packages referenced by relative URL in `index.json`. |
| `index.json` | Registry index containing the signed `keys` map (`publisherId → Ed25519 public key`) and the `plugins` catalog. |
| `index.sig` | Detached Ed25519 signature (base64) by the registry private key over the canonical JSON (recursively sorted keys, no whitespace) of `index.json`. |

## Two-Tier Ed25519 Trust Model

CadLLM uses a two-tier Ed25519 signature chain (`node:crypto`) with canonical JSON serialization (recursively sorted object keys, zero whitespace):

1. **Root Registry Authority (`registry.pub`)**
   - Clients trust a single root registry public key configured in `~/.cadllm/config.json` (`registryKey` or `registryPublicKey`), defaulting to `registry/registry.pub`.
   - The registry private key (`~/.cadllm/keys/registry.pem`) signs:
     - `index.sig`: detached Ed25519 signature over the canonical JSON of the entire `index.json`.
     - `index.keys.signature`: embedded Ed25519 signature over the canonical `{ publishers }` map binding each publisher ID to its Ed25519 public key.
   - Any tampering with `index.json` (adding/removing plugins, modifying metadata, substituting a publisher public key, or altering `index.sig`) invalidates the registry signature in `verifyIndex()`.
   - **Back up `~/.cadllm/keys/registry.pem` offline.** Losing the registry private key means rotating `registry.pub` and re-keying all clients.

2. **Publisher Authority (`keys.publishers[publisherId]`)**
   - Each publisher holds an Ed25519 keypair whose public key (`publishers/<id>.pub`) is registered in the registry-signed `keys` section of `index.json`.
   - Each published version entry `{ version, engine, url, sha256, size, permissions, contributes }` is signed by its publisher's private key (`~/.cadllm/keys/publishers/<id>.pem`) over its canonical JSON representation (excluding `signature`).
   - `verifyIndex()` and `install()` verify every version entry's `signature` against the publisher's public key from the verified `keys` map.

3. **Package Integrity, Isolation & Zero Implicit Grants**
   - `.cnlplugin` archives are deterministic ZIP packages (`fflate`) with sorted entries and fixed `1980-01-01T00:00:00` mtimes, capped at 20 MiB (`MAX_PLUGIN_BYTES`), excluding dotfiles and `node_modules`.
   - Before extraction, `install()` checks:
     1. `satisfiesEngine(version.engine, PLUGIN_API_VERSION)` compatibility.
     2. Publisher signature over the version entry.
     3. Downloaded byte length (`size`) and `sha256` digest match the signed version entry.
     4. ZIP Central Directory and Local File Headers contain no symbolic links (`S_IFLNK`), no absolute paths, no Windows drive letters, and no `..` path traversal segments (**zip-slip protection**).
   - Extraction writes into a temporary sibling directory under `<stateDir>/plugins/<id>/`, re-validates `plugin.json` (`validateManifest`) and verifies that `id`, `version`, `engine`, and `permissions` match the signed registry entry, then atomically renames to `<stateDir>/plugins/<id>/<version>/`.
   - **Installing a plugin never grants any permissions by itself.** Permission grants are stored separately in `<stateDir>/grants.json` and require explicit user opt-in (`cadllm plugin install --yes-grant`, interactive confirmation, or `cadllm plugin grant <id> <perm…>`).

## Publishing Walkthrough

1. **Generate keys outside the repository (one-time setup):**
   - Registry root keypair: `~/.cadllm/keys/registry.pem` (private, backed up offline) and `registry/registry.pub` (committed).
   - Publisher keypair: `~/.cadllm/keys/publishers/<id>.pem` (private, kept outside git) and `registry/publishers/<id>.pub` (committed).

2. **Pack the plugin directory into a deterministic `.cnlplugin` archive:**
   ```bash
   node packages/cli/src/main.ts plugin pack plugins/example-sensors --out registry/packages/org.cadllm.example-sensors-1.0.0.cnlplugin
   ```

3. **Sign the package entry and re-sign `index.json` + `index.sig`:**
   ```bash
   node packages/cli/src/main.ts plugin sign registry/packages/org.cadllm.example-sensors-1.0.0.cnlplugin \
     --key ~/.cadllm/keys/publishers/<id>.pem \
     --publisher <id> \
     --index registry \
     --registry-key ~/.cadllm/keys/registry.pem
   ```

4. **Verify before committing:**
   ```bash
   node packages/cli/src/main.ts plugin search
   ```
   Commit only `registry/packages/*.cnlplugin`, `registry/publishers/<id>.pub`, `registry/index.json`, and `registry/index.sig` — never private keys (`*.pem`, `*.key`).
