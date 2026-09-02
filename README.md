# dsh-remote

`dsh-remote` implements an SSH Remote Execution World for DeepSeek Harness (DSH). Model calls, the Agent loop, Sessions, and the UI stay local; a Rust `dsh-remote` helper runs on the remote Linux host, where files, search, Shell/PTY, processes, background jobs, signals, cancellation, and output streams all execute — with no silent fallback to local execution.

Connections reuse the system OpenSSH client: SSH config, keys, ssh-agent, and ProxyJump. DSH installs, starts, and upgrades the helper automatically, and negotiates version and capabilities.

## Goals

- Keep model calls, the Agent loop, Sessions, and the UI local.
- Run files, search, Shell/PTY, processes, background jobs, signals, cancellation, and output streams remotely — never silently falling back to local execution.
- Reuse the system OpenSSH client: SSH config, keys, ssh-agent, and ProxyJump.
- Install, start, and upgrade the helper automatically; negotiate version and capabilities.
- Make the Execution World an explicit, Agent-visible context, bound at creation time; crossing Worlds goes through a new Agent or a handoff.
- Cover plugin boundaries, lifecycle, task ownership, reconnection, and the security model.

## Scope

- V1: SSH hosts only.
- Future: composable resolvers enter SSH, Container, and other environments, starting the same helper in the final environment.

## Architecture

The repository is expected to contain:

1. A runtime owner for SSH bootstrap, connection, helper lifecycle, version/capability negotiation, and the shared remote handle (the Execution World).
2. A remote filesystem provider implementing DSH's filesystem contract, including search.
3. A remote subprocess provider implementing DSH's process and terminal contract: Shell/PTY, processes, background jobs, signals, cancellation, and output streams.
4. A user-level Rust Linux server (the helper) exposing the filesystem, search, and process/PTY APIs.
5. A composable resolver for the entry environment: SSH in V1; Container and other environments later, with the same helper started in the final environment.

## References

- DSH E2B
- Zed Remote
- VS Code nested ExecServer
- Distant
- Agent Host: future Remote Harness reference only

## Status

Early design. Protocol, package naming, and detailed UX will be decided separately.
