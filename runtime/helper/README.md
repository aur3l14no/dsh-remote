# Remote helper

This Rust crate implements the remote runtime protocol: filesystem operations, managed processes, pipes, PTY, signals, cancellation, bounded output and finite live-runtime reconnection. It has no DSH, portable_workspace, Agent, skill or tool policy dependency.

Build from the repository root with `cargo build --locked`. Cargo.lock and target/ belong to the root Cargo workspace. The binaries remain `target/debug/dsh-remote` and `target/debug/dsh-remote-fixture`.

- `src/`: helper implementation; `src/bin/dsh-remote-fixture.rs` is the acceptance child.
- `tests/acceptance.py`: target-native behavior suite.
- `scripts/build-linux.sh`: builds with an already installed target toolchain on Linux.

See the [protocol](../../docs/reference/helper-api.md), [bootstrap](../../docs/reference/bootstrap.md) and [development commands](../../docs/development.md). No automatic task persistence or replay across runtime replacement is promised.
