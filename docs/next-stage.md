# Next stage: Execution World integration

DSH owns Agents, subagents, tool filtering, Session persistence and UI. The previous plan to implement child-tool restrictions and continuation composition in this project was incorrect and is withdrawn.

## Existing implementation

- Rust helper 0.1.1 / API 1: files, atomic publication, subprocess/PTY, signals, bounded output, deduplication and finite same-runtime reconnect. No helper-restart task recovery.
- Protocol client and system OpenSSH bootstrap: trusted local artifacts, target-native helper/ripgrep, version/capability negotiation, generation coexistence and no local execution fallback.
- External FS/subprocess/PTY providers and live World context. Text-edit rules and terminal presentation stay in DSH consumers.
- Corrected standing-preset experiment using unchanged DSH Agent/ToolRuntime and subagent drivers. Custom registries, handoff, argv tool and SQLite Session implementation removed.
- Actual DSH terminal/job consumers tested as application fixtures over a shared World.
- External JSON Session–World bindings and shared routing, with actual DSH JSONL restart validation. See [lifecycle and limits](session-routing.md).
- Private compiled plugin tarball, Loader package entries, declarations and ordinary npm ripgrep identity mapping. See [package validation boundary](packaging.md).
- Experimental [SSH → Podman exec](podman.md) entry for a running container pinned by full ID; the same helper runs in the final environment.

The source baseline remains DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`; source-alias tests do not establish installed-package compatibility. See [composition](agents.md), [upstream findings](upstream-seams.md), [bootstrap](bootstrap.md) and [helper acceptance](helper-acceptance.md).

## Open integration work

1. Parent-path canonicalization is an upstream bug; retain explicit refusal and defer it.
2. Shared-router initialization/background integration remains unverified. Existing callers can explicitly select concrete providers with a bound Agent.
3. Child commit failure blocks execution, but DSH's session-start notification cannot veto Agent creation. Report this boundary instead of replacing its registry.
4. Direct subprocess ownership stays with runtime/provider and existing owner-aware consumers.

Report concrete seams to the user before expanding scope. Do not modify DSH core or replace its Agent/subagent, preset, filtering or storage systems. Continuations/forks/handoff remain DSH features; our tests should only verify World context on supported composition paths.

## Work within this project's responsibility

The proposed coordinating Web thread cannot use existing upstream messaging for independent World Sessions under the agreed same-World child rule. See [the assessment](demo-assessment.md). Defer that demo instead of implementing orchestration here. Web's local `mkdir(cwd)` during Session creation is a separate newly identified integration obstacle.

The preferred entry is now [World settings → Create Project with World + workspace](web-world-selection.md), with Sessions inheriting the project selection. The settings card has an external extension seam. Full project integration requires upstream support for environment-qualified paths, identity and lifecycle; the current Workspace registry assumes local paths throughout. First separate reusable World configuration from workspace bindings and specify the missing hooks. Do not replace DSH's project system.

- Select an installable DSH baseline before public-release compatibility validation. The current source version is not available as the corresponding npm preset package.
- Compare remote FS behavior with upstream rules; keep explicit listing/upload/output limits until bounded pagination/streaming is implemented and tested.
- Verify consumer World loss/reconnect and no direct local workspace access. Report bypasses rather than adding harness replacements.
- The tarball is tested against a source-built host fixture; verify the complete installed host when a matching dependency set is available.
- Prepare reproducible artifacts/checksums and ripgrep redistribution notices. Release catalogs/download trust and installation garbage collection remain separate work.

Bootstrap currently accepts caller-trusted local artifacts. Publishing packages, downloading release catalogs, collecting old generations and recovering forced-SIGKILL publication locks are not implemented. Public releases, general resolver composition, container lifecycle management and Remote Harness remain separate work.
