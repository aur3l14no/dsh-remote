# Next stage: Execution World integration

DSH owns Agents, subagents, tool filtering, Session persistence and UI. The previous plan to implement child-tool restrictions and continuation composition in this project was incorrect and is withdrawn.

## Existing implementation

- Rust helper 0.1.1 / API 1: files, atomic publication, subprocess/PTY, signals, bounded output, deduplication and finite same-runtime reconnect. No helper-restart task recovery.
- Protocol client and system OpenSSH bootstrap: trusted local artifacts, target-native helper/ripgrep, version/capability negotiation, generation coexistence and no local execution fallback.
- External FS/subprocess/PTY providers and live World context. Text-edit rules and terminal presentation stay in DSH consumers.
- Corrected standing-preset experiment using unchanged DSH Agent/ToolRuntime and subagent drivers. Custom registries, handoff, argv tool and SQLite Session implementation removed.
- Actual DSH terminal/job consumers tested as application fixtures over a shared World.

The source baseline remains DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`; source-alias tests do not establish installed-package compatibility. See [composition](agents.md), [upstream findings](upstream-seams.md), [bootstrap](bootstrap.md) and [helper acceptance](helper-acceptance.md).

## Upstream coordination before further adaptation

1. Delegate tool-fs parent-path canonicalization to the selected World filesystem. Affected requests currently fail explicitly.
2. Establish required durable World metadata and validation during reconstruction. Safe cold resume must not depend only on preset ID/cwd; do not replace Session storage.
3. Clarify independent World selection with a shared preset. The current experiment uses one World per standing generation.
4. Clarify direct subprocess ownership if automatic per-Agent cleanup is required outside owner-aware consumers.

Report concrete seams to the user before expanding scope. Do not modify DSH core or replace its Agent/subagent, preset, filtering or storage systems. Continuations/forks/handoff remain DSH features; our tests should only verify World context on supported composition paths.

## Work within this project's responsibility

- Wire the existing SSH bootstrap/readiness into installable provider configuration after agreeing the host/preset binding contract.
- Verify exact packaged-ripgrep resolution in the Node/package branch as well as the accepted bundled-sidecar branch.
- Compare remote FS behavior with upstream rules; keep explicit listing/upload/output limits until bounded pagination/streaming is implemented and tested.
- Verify consumer World loss/reconnect and no direct local workspace access. Report bypasses rather than adding harness replacements.
- Verify independently installed external packages against a pinned installable DSH dependency set.
- Prepare reproducible artifacts/checksums and ripgrep redistribution notices. Release catalogs/download trust and installation garbage collection remain separate work.

Bootstrap currently accepts caller-trusted local artifacts. Publishing packages, downloading release catalogs, collecting old generations and recovering forced-SIGKILL publication locks are not implemented. Public releases, Container resolvers and Remote Harness remain separate work.
