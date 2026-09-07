# World selection in Web projects

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

Deferred product flow based on unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. A [source-only Project experiment](../../../../integrations/dsh/experiments/portable_workspace/README.md) validates the service and entry wiring. Settings/UI and transparent Web activation are not implemented, and their development is paused.

## User flow

1. In Web Settings → Plugins, manage a World catalog: stable ID, display name and SSH entry, optionally followed by the supported Podman step. Authentication continues through system OpenSSH.
2. In Create Project, select a World, then enter or browse an existing workspace in that World. Resolve and validate the path remotely. Directory creation, if offered, must also execute in the selected World.
3. The project retains `(worldId, canonical workspace)`. New Sessions inherit that selection and commit the external Session binding before Agent execution. Resume uses the saved binding.
4. Show the World name and workspace in the project/session context. An unavailable or removed World remains identifiable and reports failure; it never becomes local. Changing catalog connection settings must not redirect existing bindings silently.

A World catalog describes the execution environment; a project chooses a directory within it. One World can host many projects, and different Worlds can contain the same path. Their project identities must remain distinct. This does not require a preset per World.

The current `WorldDefinition` combines SSH coordinates and `cwd`. The experiment keeps this contract: catalog entries describe reusable environments, while Projects receive distinct concrete workspace binding IDs. Existing v1 bindings are not migrated or reinterpreted. Saved Projects pin the catalog connection definition; removing or changing it prevents opening them. The experimental Project storage format is not a released contract.

## External plugin seam

DSH's Web plugin configuration has the `settings.plugin.item` slot and `settingsScope`; the host settings controller exposes registered namespaces with schema, revisioned writes and secret redaction. A World settings card and catalog can use these existing seams. Adding a TypeScript `Config` interface alone does not register a settings namespace or render a card. Save catalog configuration locally; keep the Session binding map separate from DSH history.

## Limits of the built-in project plugins

| Existing behavior | Required capability |
| --- | --- |
| Directory-flow `onPicked(path)` and `createWorkspace({ path })` carry only a host path. | Carry a selected environment plus path through project creation. |
| `WorkspaceRegistry.create/resolveByPath` use local `realpath`/`stat` and deduplicate solely by canonical path. | Resolve paths in the selected environment and distinguish identical paths in different Worlds. |
| Workspace status, Session attachment and recovery also validate local paths; records contain no World identity. | Preserve environment-qualified project identity and use it consistently during attachment/status/recovery. |
| Web Session creation runs local `mkdir(cwd)` before Agent preset setup. | Await World/binding preparation before publication, with workspace operations delegated to the selected provider. |

A lightweight external Project–World map cannot by itself prevent the unchanged registry from merging equal paths, rejecting remote-only directories, or validating them locally. Replacing just the directory picker is insufficient. These findings constrain reuse of the built-in project composition; they do not establish that an external Project plugin is impossible.

## Separate Project integration plugin

DSH's Workspace registry, API controller and project UI are plugins themselves. The experiment replaces the Workspace service while retaining native Agent/Session services. The UI exposes `sidebar.workspaces` and `conversation.hero.workspace` slots for a World-aware project region and picker; that UI composition remains untested.

| Component | Responsibility |
| --- | --- |
| `dsh-remote` | World connections, helper lifecycle, execution providers and Session binding context. |
| Separate Project plugin | World + workspace selection, project identity and persistence, project UI, and creation/resume entry wiring. |
| Existing DSH services | Agent creation/loop, subagents, tool filtering, Session history, model execution and conversation UI. |

The Project plugin must make the relevant project operations environment-aware: registration, identity, status, membership and reload. Where public contracts permit, it can supply compatible services or reuse existing components. The local registry must not remain active scanning remote Session cwd values through local `realpath`; disabling only its picker is insufficient. Do not encode fake local paths or monkey-patch Node filesystem calls.

Creation/resume entry wiring means preparing the World and durable binding, then calling the ordinary DSH Agent APIs and opening that Session through the existing UI. It does not mean another Agent registry, Session backend, subagent driver or message system. The normal Web controller's local mkdir and cold-resume behavior still need a verified composition path; slots alone do not solve them.

The experiment establishes distinct same-path Projects and explicit Project create/reopen through native Agent/Session services. Unchanged Web activation controllers adopt those live Sessions. Missing or changed World configuration rejects before activation.

It also reproduces the remaining entry gap: unprepared Web creation runs local `mkdir`; cold Web activation skips preparation and fails the World guard. The Session Controller owns its Typert lookup exclusively and promotes history followers through a private activation controller. A Project picker cannot cover those paths. No complete Web profile or browser flow is claimed.

Decision: defer this Web flow and retain the experiment as evidence. Upstream changes are outside our control; obtaining a new preparation hook is not a next step. Reopen this work only with a concrete route through supported existing interfaces that covers these entry paths and keeps directory operations in the World. Keep the experiment out of the distributed plugin.

Keep any future replacement within Project responsibilities. If the inherited API cannot support the flow without changing Agent/Session ownership or relying on private internals, omit the feature. This limitation does not initiate migration to another agent host or a self-built harness.

Source anchors in the pinned upstream:

- `packages/client/ui-settings-plugins/src/client/index.ts`: settings cards and slot registration.
- `packages/api/settings-controller/src/index.ts`: namespace description and revisioned writes.
- `packages/client/ui-workspace/src/client/contract/slots.ts`: directory result and project-create input.
- `packages/api/workspace-controller/src/types.ts`: `WorkspaceCreateRequest` and `WorkspaceView`.
- `packages/workspace/workspace/src/index.ts`: create, path uniqueness and recovery.
- `packages/workspace/workspace/src/entity.ts`: Session attachment and directory status.
- `packages/api/session-controller/src/agent.ts`: `createOrAdopt`.
