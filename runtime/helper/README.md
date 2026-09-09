# Remote helper

This Rust crate implements the remote runtime protocol: filesystem operations, managed processes, pipes, PTY, signals, cancellation, bounded output and finite live-runtime reconnection. It has no DSH, portable_workspace, Agent, skill or tool policy dependency.

Build from the repository root with `cargo build --locked`. Cargo.lock stays at the workspace root; .cargo/config.toml directs build artifacts to runtime/helper/target/. The binaries remain `runtime/helper/target/debug/dsh-remote` and `runtime/helper/target/debug/dsh-remote-fixture`.

- `src/`: helper implementation; `src/bin/dsh-remote-fixture.rs` is the acceptance child.
- `tests/acceptance.py`: target-native behavior suite.
- `scripts/build-linux.sh`: builds with an already installed target toolchain on Linux.

See the [protocol](../../docs/reference/helper-api.md), [bootstrap](../../docs/reference/bootstrap.md) and [development commands](../../docs/development.md). No automatic task persistence or replay across runtime replacement is promised.
