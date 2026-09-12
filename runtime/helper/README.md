# Remote helper

This Rust crate implements the remote runtime protocol: filesystem operations, managed processes, pipes, PTY, signals, cancellation, bounded output and finite live-runtime reconnection. It has no DSH, portable_workspace, Agent, skill or tool policy dependency.

The executable is named `dsh-remote-helper`.

Build with `cd runtime/helper && cargo build --locked`. This is a standalone crate: Cargo.toml, Cargo.lock and target/ all live here. From the repository root, binaries are at `runtime/helper/target/debug/dsh-remote-helper` and `runtime/helper/target/debug/dsh-remote-fixture`.

- `src/`: helper implementation; `src/bin/dsh-remote-fixture.rs` is the acceptance child.
- `tests/acceptance.py`: target-native behavior suite.
- `scripts/build-linux.sh`: builds with an already installed target toolchain on Linux.

See the [protocol](../../docs/reference/helper-api.md), [bootstrap](../../docs/reference/bootstrap.md) and [development commands](../../docs/development/README.md). No automatic task persistence or replay across runtime replacement is promised.
