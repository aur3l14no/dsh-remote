# DSH integration findings and responsibility boundary

Inspected source: DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`, unchanged. Findings concern this pinned revision, not every published package or newer revision. No issue or message has been sent upstream.

## Resolved embedding mistake

The filter conflict came from this project's per-Agent registration, not a need for a subagent implementation. DSH `ToolRuntime.view()` filters inherited tools and then adds the scope's own registrations. We incorrectly registered every tool in each Agent's own scope and used a replacement ToolRuntime to reject filters.

The existing standing-preset seam resolves this. `AgentPresets.mount()` mounts once; `composeFrom()` joins a child to the same generation. The existing in-process driver calls `applyChildComposition()` and then applies DSH's filters. Tests now use these exact implementations, including a child executing a remote read. No continuation or handoff manager belongs here.

Source locations: `packages/core/tools/src/index.ts` (`view`, `restrict`), `packages/preset/agent-presets/src/index.ts` (`mount`, `composeFrom`), `packages/subagent/subagent/src/child-agent.ts` (`applyChildComposition`, `childSessionMeta`), and `packages/e2b/e2b/tests/fixtures/composition/cordis.yml`.

## Remaining interfaces to discuss

| Boundary | Evidence and consequence | Treatment here |
| --- | --- | --- |
| Parent-path filesystem resolution | `packages/fs/tool-fs/src/session-cwd.ts` calls `canonicalPath(cwd)` for `..`, using local filesystem identity before reaching the remote provider. | Refuse affected requests. Request upstream delegation to the selected filesystem provider. No ToolRuntime replacement or argument-rewriting registry. |
| Durable World identity | `packages/core/session/src/types.ts` has cwd/preset fields but no World identity; `packages/session/session-persistence/src/storage-contract.ts` rejects required events outside its generated known-event catalog. Preset ID/cwd cannot detect a changed target at the same path after restart. | Safe cold-resume validation remains open. Request a required identity/extension contract and reconstruction validation. Do not mark ownership ignorable or create another Session database. |
| Preset identity versus execution identity | Standing mounts are keyed by preset ID/generation. A configured World is shared by joined Agents. | Accepted scope: one World per standing preset generation. Independent dynamic World selection with one preset needs an explicit host/preset binding seam. Do not build another preset/Agent system to hide this coupling. |
| Publication timing | `AgentLoop.setupAndPublish()` calls setup commit, then awaits persistence before publication. A synchronous `agent/created` listener can reject publication and trigger DSH rollback. | Use the existing event for live World identity checks. Coordinate a universal durable validation hook upstream rather than replacing the registry. |
| Raw subprocess ownership | Subprocess spawn specs carry no Agent owner. Existing terminal/job consumers do carry owners and clean their own work. | Keep runtime/provider ownership and consumer cleanup. If every raw spawn must be automatically attributed, request an explicit ownership seam instead of guessing from ancestry. |

Execution World belongs here: target resolution/provisioning, runtime lifecycle, remote capabilities, FS/subprocess/PTY semantics, World identity/context and no local fallback. Agent creation, delegation, filters, fork/continuation/handoff, job policy, Session persistence and UI belong to DSH or its existing consumers. Integration tests do not transfer implementation ownership.
