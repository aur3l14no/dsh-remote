# Execution runtime

This subsystem is independent of DSH. Its two private npm packages run locally in Node.js; the Rust helper runs in the selected execution environment.

```text
DSH plugin (integrations/dsh/)
  → ssh/       TypeScript: OpenSSH transport, installation and bootstrap
  → client/    TypeScript: protocol requests, responses and process handles
  → SSH stdio
  → helper/    Rust: workspace filesystem, processes and PTY
```

The SSH library uses the protocol client to establish a runtime connection. The caller then uses that client for workspace operations. Neither library imports DSH APIs.

Package names remain `@dsh-remote/client` and `@dsh-remote/ssh`; `helper/` is a Cargo crate, not an npm package. Run Cargo inside `runtime/helper/`, which owns its manifest, lockfile and default `target/`. General client/bootstrap tests live in `runtime/tests/`, while DSH integration tests live under `integrations/dsh/tests/`.

See [system map](../docs/system-map-1.md) and [development](../docs/development.md).
