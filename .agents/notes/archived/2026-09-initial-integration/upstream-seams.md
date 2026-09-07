# Known integration issues

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

Baseline: unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. [Persistent routing](session-routing.md) implements:

`Tool call Agent → Session ID → binding map → World → remote client`

An external JSON map holds bindings; DSH retains Session history. Shared presets route through the public tool-dispatch hook. Creation, child inheritance and restart into a new helper are covered by the integration fixture.

| Issue | Current behavior | Next step |
| --- | --- | --- |
| Parent-path resolution | DSH tool-fs calls local `realpath` for `..`; affected requests are refused. | Upstream bug; deferred. |
| Web activation | Direct creation calls local `mkdir` before World admission; cold activation lacks preparation. Its owned lookup rejects a second resolver. | Reproduced in the [Project experiment](../../../../integrations/dsh/experiments/portable_workspace/README.md). Accepted limitation; no upstream-change dependency. |
| Web Project integration | Replacement service supports World-qualified identity and explicit native Session create/reopen. | Full Web integration deferred. Keep experiment/evidence; stop settings, Project feed and browser work. |
| Cross-root demo orchestration | Ordinary messaging is parent/child-only; experimental Teams also creates subagents in one shared workspace. | Defer the main-thread/multi-World demo. Cross-root messaging belongs upstream or in a separate plugin. |
| Calls outside tool dispatch | Explicit `forAgent` lookup is available; automatic terminal/job initialization through the shared router is unverified. | Defer consumer integration; never infer a default World. |
| Child publication failure | DSH contains session-start observer errors. A failed binding commit can leave a published Agent whose model context/tools are blocked. | Keep fail-closed admission. Atomic rejection of creation needs a suitable upstream hook. |
| Interrupted mapping write | Atomic JSON remains readable; forced writer death can leave a lock. | Report busy; verified manual lock recovery. Automatic recovery/garbage collection deferred. |
| Public DSH package baseline | The tarball loads in a source-built host; the matching `0.1.3-alpha.1` preset package is absent from npm. | Keep exact baseline requirements; validate an installed release when available. |
| Raw subprocess ownership | Runtime/provider owns raw handles; DSH terminal/job consumers track Agent owners. | Accepted boundary; no replacement Agent manager. |

Bindings pin World IDs and selected SSH coordinates. SSH config remains authoritative. Root selections and successful child bindings survive failed/later Agent lifecycles; there is no distributed transaction with Session storage. Restoring a binding does not restore tasks across helper restarts.

Resolved: per-Agent tool registration caused the filter conflict. Standing presets let children inherit the same World/tool instances and use DSH's native filters. Custom Agent, ToolRuntime, handoff and Session implementations were removed.

Source anchors: `packages/fs/tool-fs/src/session-cwd.ts`; `packages/core/session/src/types.ts`; `packages/session/session-persistence/src/storage-contract.ts`; `packages/preset/agent-presets/src/index.ts`; `packages/core/agent-loop/src/index.ts`; `packages/subprocess/subprocess/src/types.ts`. Composition references: `packages/subagent/subagent/src/child-agent.ts` and `packages/e2b/e2b/tests/fixtures/composition/cordis.yml`.

Scope: the execution plugin owns execution providers, lifecycle and World context. A separate Project plugin may own project location, identity and UI integration. DSH retains Agents, delegation, filtering, Session history and conversation UI. Report concrete incompatible interfaces rather than expanding the execution plugin into another harness.

Missing host interfaces may mean omitting a feature. Host migration or a self-built agent is not planned now; reassess only if accumulated limitations undermine the core use case.
