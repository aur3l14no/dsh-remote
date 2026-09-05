# dsh-remote

`dsh-remote` is developing an SSH Remote Execution World for DeepSeek Harness (DSH). Model calls, the Agent loop, Sessions, and the UI stay local; a Rust `dsh-remote` helper runs on the remote Linux host, where files, search, Shell/PTY, processes, background jobs, signals, cancellation, and output streams execute with no silent fallback to local execution.

Connections reuse system OpenSSH: SSH config, keys, ssh-agent, and ProxyJump. The SSH bootstrap installs, validates, starts and upgrades helper/ripgrep from a caller-trusted manifest and local artifact cache. Agent creation-time World binding and production artifact distribution remain planned.

## Goals

- Keep model calls, the Agent loop, Sessions, and the UI local.
- Run files, search, Shell/PTY, processes, background jobs, signals, cancellation, and output streams remotely — never silently falling back to local execution.
- Reuse the system OpenSSH client: SSH config, keys, ssh-agent, and ProxyJump.
- Install, start, and upgrade the helper automatically; deploy target-platform ripgrep and negotiate version and capabilities.
- Make the Execution World an explicit, Agent-visible context, bound at creation time; crossing Worlds goes through a new Agent or a handoff.
- Cover plugin boundaries, lifecycle, task ownership, reconnection, and the security model.

## Scope

- V1: SSH hosts only.
- Ship entirely as external DSH plugins and the Rust helper; no DSH core patch is assumed.
- Develop incrementally, starting with the helper. A working helper is an intermediate milestone, not proof of DSH integration.
- The helper API and behavior are approved; message revision 1 and the Rust helper are implemented. Native acceptance covers embedded Linux/musl, containerized Linux/glibc, and macOS, with explicit target selection.
- V1 provides managed subprocesses and background execution during the live runtime, without helper-managed task persistence, detached task supervision, or cross-restart recovery. Agents may arrange persistence themselves using remote programs.
- Future: composable resolvers enter SSH, Container, and other environments, starting the same helper in the final environment.

## Agreed constraints

- Follow the E2B provider-composition seam: one runtime owner, with filesystem and subprocess providers sharing its remote handle. Verify actual DSH contracts before fixing adapter or protocol details.
- Keep World identity separate from SSH connection lifetime. A World records the target environment, workspace, and execution configuration; compatible connections/helpers may be shared. Bind Agents at creation, inherit the binding for child Agents by default, and require explicit creation or handoff for another World.
- Route all workspace filesystem and process operations, including those initiated by plugins, through the bound World. Incompatible consumers must be adapted, excluded from the remote composition, or rejected explicitly.
- Use the SSH account's existing permissions. The workspace is a working-directory convention, not a sandbox. Assume a separate Auto Approval plugin exists; this project supplies World-aware execution context to that approval boundary rather than implementing the approval policy.
- Upload a compatible Linux ripgrep binary and run search through the remote subprocess provider. Bind DSH's known packaged ripgrep executable to that remote installation; prefer reusing the existing search tools over implementing a separate search engine.
- Follow DSH's managed-process and job cleanup contracts. Within a bounded grace period, reconnection resumes the same live runtime and its handles/output. Same-session request retransmission is deduplicated; a new runtime never automatically re-executes old commands. Persistence beyond the managed runtime is left to Agent-selected remote programs.
- Bootstrap without sudo: obtain the target helper and ripgrep locally and upload them through SSH, including when the remote host has no public internet access. Preserve OpenSSH authentication and host-verification behavior. Install versioned artifacts without replacing a running helper.

## Architecture

The repository is expected to contain:

1. A runtime owner for SSH bootstrap, connection, helper lifecycle, version/capability negotiation, and the shared remote handle (the Execution World).
2. A remote filesystem provider implementing DSH's filesystem contract, with search using uploaded ripgrep through the remote subprocess provider and an explicit managed-executable mapping.
3. A remote subprocess provider implementing DSH's process and terminal contract: Shell/PTY, processes, background jobs, signals, cancellation, and output streams.
4. A user-level Rust Linux server (the helper) exposing filesystem and process/PTY APIs, with search executed by the uploaded ripgrep.
5. A composable resolver for the entry environment: SSH in V1; Container and other environments later, with the same helper started in the final environment.

See [design constraints, DSH seam findings, and development stages](docs/design.md). This distinguishes agreed requirements from proposed mechanisms and unverified compatibility.

The [helper API contract](docs/helper-api.md) defines message framing, methods, lifetime, file publication, and output controls. The [platform acceptance plan](docs/helper-acceptance.md) specifies the implementation gates and shared tests without recording private connection targets.

## References

- DSH E2B
- Zed Remote
- VS Code nested ExecServer
- Distant
- Agent Host: future Remote Harness reference only

## Status

Helper 0.1.1, the TypeScript protocol client, system-SSH bootstrap and a minimal external DSH FS/subprocess composition are implemented. The client keeps a bounded request journal, resumes the same runtime, and installs final collected output before publishing completion. The real DSH search consumer works with its unchanged 20,000,000-byte budget, including after automatic SSH installation. See the [bootstrap behavior and acceptance](docs/bootstrap.md), [client/composition scope](docs/client.md) and [helper acceptance](docs/helper-acceptance.md).

This is a development milestone. Creation-time Agent binding and logged World context, trusted release downloads/distribution, published-package compatibility, and the DSH terminal adapter remain in the [next-stage plan](docs/next-stage.md). The helper itself already supports PTYs; the initial DSH adapter rejects terminal allocation explicitly.

## Build and exercise the helper

```sh
cargo build --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
```

The helper and `dsh-remote-fixture` acceptance child are built separately as binaries. On a Linux build machine, `sh scripts/build-linux.sh aarch64-unknown-linux-musl` uses the installed Rust target and bundled linker for a static embedded Linux build. It does not install a compiler on the embedded target.

```sh
dsh-remote start --runtime-dir /tmp/example-dsh-runtime --cwd /tmp
dsh-remote connect --socket /tmp/example-dsh-runtime/socket
```

The runtime directory must not already exist. `connect` speaks the framed protocol, not an interactive shell. Production callers launch it through system SSH. Use `python3 tests/acceptance.py --help` for the common platform suite and `python3 scripts/upload-artifacts.py --help` for checksum-verified SSH-stdio uploads into an existing dedicated acceptance directory. Connection targets are runtime inputs; repository artifacts identify platforms only.
