# `@cadllm/plugin-api`

Public API package for CadLLM plugins (manifest schema, contribution types, capability RPC protocol, and `definePlugin` / `connect` helpers).

## Licensing (CadLLM Plugin Exception)

CadLLM is licensed under `GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception` (see [`LICENSE-EXCEPTION.md`](../../LICENSE-EXCEPTION.md) at the repository root).

Plugins that interact with CadLLM **only** through `@cadllm/plugin-api` (the `plugin.json` manifest format, the capability RPC protocol, and the documented data formats for parts, simulation models, and project files) **may use any license**, including MIT, BSD, Apache-2.0, or proprietary/commercial licenses.

This exception does not cover copying or modifying CadLLM application internals outside `@cadllm/plugin-api`.
