# Known integration issues

Baseline: unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. [Persistent routing](session-routing.md) implements:

`Tool call Agent → Session ID → binding map → World → remote client`

An external JSON map holds bindings; DSH retains Session history. Shared presets route through the public tool-dispatch hook. Creation, child inheritance and restart into a new helper are covered by the integration fixture.

| Issue | Current behavior | Next step |
| --- | --- | --- |
| Parent-path resolution | DSH tool-fs calls local `realpath` for `..`; affected requests are refused. | Upstream bug; deferred. |
| Calls outside tool dispatch | Explicit `forAgent` lookup is available; automatic terminal/job initialization through the shared router is unverified. | Defer consumer integration; never infer a default World. |
| Child publication failure | DSH contains session-start observer errors. A failed binding commit can leave a published Agent whose model context/tools are blocked. | Keep fail-closed admission. Atomic rejection of creation needs a suitable upstream hook. |
| Interrupted mapping write | Atomic JSON remains readable; forced writer death can leave a lock. | Report busy; verified manual lock recovery. Automatic recovery/garbage collection deferred. |
| Public DSH package baseline | The tarball loads in a source-built host; the matching `0.1.3-alpha.1` preset package is absent from npm. | Keep exact baseline requirements; validate an installed release when available. |
| Raw subprocess ownership | Runtime/provider owns raw handles; DSH terminal/job consumers track Agent owners. | Accepted boundary; no replacement Agent manager. |

Bindings pin World IDs and selected SSH coordinates. SSH config remains authoritative. Root selections and successful child bindings survive failed/later Agent lifecycles; there is no distributed transaction with Session storage. Restoring a binding does not restore tasks across helper restarts.

Resolved: per-Agent tool registration caused the filter conflict. Standing presets let children inherit the same World/tool instances and use DSH's native filters. Custom Agent, ToolRuntime, handoff and Session implementations were removed.

Source anchors: `packages/fs/tool-fs/src/session-cwd.ts`; `packages/core/session/src/types.ts`; `packages/session/session-persistence/src/storage-contract.ts`; `packages/preset/agent-presets/src/index.ts`; `packages/core/agent-loop/src/index.ts`; `packages/subprocess/subprocess/src/types.ts`. Composition references: `packages/subagent/subagent/src/child-agent.ts` and `packages/e2b/e2b/tests/fixtures/composition/cordis.yml`.

Scope: this project owns execution providers, lifecycle and World context. DSH owns Agents, delegation, filtering, Session history and UI. If existing interfaces cannot support the mapping or World selection, report the limitation before adding another framework.
