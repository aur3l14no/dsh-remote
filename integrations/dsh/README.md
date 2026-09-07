# DeepSeek Harness integration

DSH-specific code lives here. Shared transport/protocol code stays in ../../packages; Rust stays in ../../helper.

- `plugins/ssh-world/`: implemented World owner, providers, binding store and routing; packaged as `@dsh-remote/ssh-world`.
- `patches/`: pinned upstream revision and ordered downstream patches. The series is empty; no patched host is shipped yet.
- `profiles/`: application composition policy; runnable remote Web profile is pending verification.
- `experiments/project-worlds/`: source-only Project registry/entry proof, excluded from distribution.
- `tests/`: bindings and pinned-host integration fixtures.
- `scripts/`: check/build/package/acceptance commands, run from the repository root.
- `packaging/`: plugin tarball manifest and consumer README.

See [architecture](../../docs/architecture.md), [execution boundaries](../../docs/execution-boundaries.md) and the [active plan](../../.agents/notes/proposed/integration/2026-09-07-world-project-web.md).
