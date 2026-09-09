# Multi-World demonstration assessment

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

Assessed against unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. This is a source assessment, not a completed Web demonstration.

The requested scenario has one Web root Agent create independent Sessions in different Worlds, communicate with them and summarize their results. The current upstream composition cannot provide that scenario under our requirement that subagents inherit their parent's World.

| Surface | Finding |
| --- | --- |
| Web Session API | Has create, prompt, cancel and history APIs for independent Sessions. These are host/UI operations, not an existing model-facing cross-root messaging service. |
| `send_message` | Authorizes direct continuable parent/child relationships, not unrelated root Sessions. |
| Experimental Agent Teams | Supports durable peer messages, but creates teammates through `subagents.startContinuable` under the Lead. Its documented scope is one shared workspace; it cannot supply independent World Sessions under the agreed inheritance rule. |
| Web World creation | `ApiSessionAgentController.createOrAdopt` calls local `node:fs/promises.mkdir(cwd)` before mounting the Agent preset. The remote FS provider cannot intercept it. Creation requests also have no World selection field. |

Do not build a cross-root Agent registry, mailbox or delegation tools here, or make a child switch Worlds to fit the demo. An independent orchestration plugin could use DSH's ordinary APIs later; its authority, messaging and lifecycle would belong to that plugin. The upstream limitation is the missing ready-to-use cross-root composition, not an absence of all multi-agent capabilities.

The [Project experiment](../../../../integrations/dsh/tests/integration/README.md) now verifies that preparing a bound native Agent lets Web's activation controllers adopt its explicit ID without local mkdir. Explicit Project reopen also restores native JSONL Sessions. Direct cold Web activation still skips World preparation, and direct new-Session creation still makes a local directory. This is controller-level evidence, not a browser demo.

The [proposed delivery direction](delivery-plan.md) first verifies a usable explicit entry through a real DSH profile. [Web Project selection](web-world-selection.md) remains deferred. A subsequent one-page report can compare platform, final environment, file/search results, PTY, cancellation, reconnect and cleanup. Label it as acceptance evidence; it must not imply a coordinating model or cross-Session communication was exercised.

Source anchors in the pinned upstream:

- `packages/api/session-controller/src/index.ts`: public create/prompt/cancel/history methods.
- `packages/api/session-controller/src/types.ts`: `SessionCreateRequest`.
- `packages/api/session-controller/src/agent.ts`: `createOrAdopt` and `composeAgent`.
- `packages/subagent/tool-subagent-control/src/index.ts`: `send_message` authority.
- `packages/subagent/subagent/src/continuation.ts`: `sendMessage` and child ownership validation.
- `packages/experimental/agent-team/src/roster.ts`: `spawnAdmitted`.
- `packages/experimental/agent-team/README.md`: shared-workspace and experimental-release limits.
