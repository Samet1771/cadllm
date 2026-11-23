# CadLLM Plugin Registry (`registry/`)

> [!CAUTION]
> **`registry.dev.pem` and `publishers/cadllm-examples.dev.pem` ARE COMMITTED TO THIS REPOSITORY ONLY BECAUSE THIS IS THE LOCAL DEVELOPMENT AND AUTOMATED TEST REGISTRY. NEVER USE THESE PRIVATE KEYS IN PRODUCTION.**

## Overview & Files

| File | Purpose |
|---|---|
| `registry.pub` | Default trusted Ed25519 public key (SPKI PEM) for verifying `index.json` / `index.sig` and publisher key bindings. |
| `registry.dev.pem` | **DEV/TEST ONLY** Ed25519 private key (PKCS#8 PEM) used by local development and test suites to sign `index.json` and `index.sig`. |
| `publishers/cadllm-examples.pub` | Ed25519 public key for the built-in example publisher (`cadllm-examples`). |
| `publishers/cadllm-examples.dev.pem` | **DEV/TEST ONLY** Ed25519 private key for signing example plugin packages during development and E2E tests. |
| `packages/*.cnlplugin` | Deterministic `.cnlplugin` ZIP packages hosted by the local dev registry and referenced by relative URL in `index.json`. |
| `index.json` | Registry index containing the signed `keys` map (`publisherId → Ed25519 public key`) and the `plugins` catalog. |
| `index.sig` | Detached Ed25519 signature (base64) by the registry private key over the canonical JSON (recursively sorted keys, no whitespace) of `index.json`. |

## Two-Tier Ed25519 Trust Model

CadLLM uses a two-tier Ed25519 signature chain (`node:crypto`) with canonical JSON serialization (recursively sorted object keys, zero whitespace):

1. **Root Registry Authority (`registry.pub`)**
   - The client trusts a single root registry public key configured in `~/.cadllm/config.json` (`registryKey` or `registryPublicKey`), defaulting to `registry/registry.pub`.
   - The registry private key signs:
     - `index.sig`: detached Ed25519 signature over the canonical JSON of the entire `index.json`.
     - `index.keys.signature`: embedded Ed25519 signature over the canonical `{ publishers }` map binding each publisher ID to its Ed25519 public key.
   - Any tampering with `index.json` (adding/removing plugins, modifying metadata, substituting a publisher public key, or altering `index.sig`) invalidates the registry signature in `verifyIndex()`.

2. **Publisher Authority (`keys.publishers[publisherId]`)**
   - Each publisher holds an Ed25519 keypair whose public key is listed in the registry-signed `keys` section of `index.json`.
   - Each published version entry `{ version, engine, url, sha256, size, permissions, contributes }` is signed by its publisher's private key over its canonical JSON representation (excluding `signature`).
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

## Publishing a Plugin Package

```bash
node packages/cli/src/main.ts plugin pack plugins/example-sensors --out registry/packages/org.cadllm.example-sensors-1.0.0.cnlplugin
node packages/cli/src/main.ts plugin sign registry/packages/org.cadllm.example-sensors-1.0.0.cnlplugin --key registry/publishers/cadllm-examples.dev.pem --publisher cadllm-examples --index registry --registry-key registry/registry.dev.pem
```

## Rotating to a Production Registry Key (Kept Out of Git)

To deploy or switch to a production plugin registry:

1. **Generate a production registry keypair outside the git repository:**
   ```bash
   cadllm plugin keygen /secure/offline/path/prod-registry
   ```
   Store `/secure/offline/path/prod-registry.dev.pem` in your offline hardware token, secret manager, or signing CI environment. **Never commit the production private key to git.**

2. **Publish the production public key and remove development private keys:**
   - Replace `registry/registry.pub` with `/secure/offline/path/prod-registry.pub` (or distribute the public key and configure `"registryKey"` in `~/.cadllm/config.json` alongside `"registryUrl"`).
   - Delete `registry/registry.dev.pem` and `registry/publishers/*.dev.pem` from the production branch.

3. **Register real publisher public keys & sign the index:**
   - Add each verified publisher's `.pub` key to `index.json` and sign packages using the offline/CI registry key:
     ```bash
     cadllm plugin sign <package.cnlplugin> \
       --key <publisher-private.pem> \
       --publisher <publisher-id> \
       --index registry/ \
       --registry-key /secure/offline/path/prod-registry.dev.pem
     ```
