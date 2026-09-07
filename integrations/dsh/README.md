# DeepSeek Harness integration

DSH-specific code lives here. Shared transport/protocol code and Rust stay in ../../runtime.

- `plugins/ssh-world/`: implemented World owner, providers, binding store and routing; packaged as `@dsh-remote/ssh-world`.
- `plugins/session-admission/`: source-only adapter for the patched host and experimental registry.
- `patches/`: pinned upstream revision and ordered downstream patches. The first Session admission patch has a separate source-build/behavior gate; a complete patched Web distribution is not shipped.
- `profiles/`: application composition policy; runnable remote Web profile is pending verification.
- `experiments/portable_workspace/`: source-only portable_workspace registry/entry proof, excluded from distribution.
- `tests/`: bindings and pinned-host integration fixtures.
- `scripts/`: check/build/package/acceptance commands, run from the repository root.
- `packaging/`: plugin tarball manifest and consumer README.

See [architecture](../../docs/architecture.md), [execution boundaries](../../docs/execution-boundaries.md) and the [active plan](../../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md).
