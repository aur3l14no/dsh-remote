# World selection in Web projects

Proposed product flow, based on unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. Not implemented; no upstream patch is assumed.

## User flow

1. In Web Settings → Plugins, manage a World catalog: stable ID, display name and SSH entry, optionally followed by the supported Podman step. Authentication continues through system OpenSSH.
2. In Create Project, select a World, then enter or browse an existing workspace in that World. Resolve and validate the path remotely. Directory creation, if offered, must also execute in the selected World.
3. The project retains `(worldId, canonical workspace)`. New Sessions inherit that selection and commit the external Session binding before Agent execution. Resume uses the saved binding.
4. Show the World name and workspace in the project/session context. An unavailable or removed World remains identifiable and reports failure; it never becomes local. Changing catalog connection settings must not redirect existing bindings silently.

A World catalog describes the execution environment; a project chooses a directory within it. One World can host many projects, and different Worlds can contain the same path. Their project identities must remain distinct. This does not require a preset per World.

The current `WorldDefinition` combines SSH coordinates and `cwd`, and its immutable ID rejects another cwd. The catalog therefore cannot directly expose these existing records as environment definitions. Separate reusable environment configuration from the bound workspace before adding the UI. Preserve existing binding identities through an explicit compatibility/migration design; do not reinterpret saved IDs or rewrite live bindings in place. This note does not fix a new storage or wire format.

## External plugin seam

DSH's Web plugin configuration has the `settings.plugin.item` slot and `settingsScope`; the host settings controller exposes registered namespaces with schema, revisioned writes and secret redaction. A World settings card and catalog can use these existing seams. Adding a TypeScript `Config` interface alone does not register a settings namespace or render a card. Save catalog configuration locally; keep the Session binding map separate from DSH history.

## Upstream project limitations

| Existing behavior | Required capability |
| --- | --- |
| Directory-flow `onPicked(path)` and `createWorkspace({ path })` carry only a host path. | Carry a selected environment plus path through project creation. |
| `WorkspaceRegistry.create/resolveByPath` use local `realpath`/`stat` and deduplicate solely by canonical path. | Resolve paths in the selected environment and distinguish identical paths in different Worlds. |
| Workspace status, Session attachment and recovery also validate local paths; records contain no World identity. | Preserve environment-qualified project identity and use it consistently during attachment/status/recovery. |
| Web Session creation runs local `mkdir(cwd)` before Agent preset setup. | Await World/binding preparation before publication, with workspace operations delegated to the selected provider. |

A lightweight external Project–World map could retain an association if suitable hooks exist. It cannot by itself prevent the current registry from merging equal paths, rejecting remote-only directories, or validating them locally. Replacing just the directory picker is insufficient. Replacing the Workspace registry/sidebar, encoding fake local paths or monkey-patching Node filesystem calls is outside this project's approach.

The next step is to specify these minimal upstream extension needs and implement the independent World catalog/settings portion. Full Create Project integration is gated on a suitable upstream seam. DSH continues to own projects, Agents, Session history and navigation; this plugin supplies environment selection, remote execution and durable binding context.

Source anchors in the pinned upstream:

- `packages/client/ui-settings-plugins/src/client/index.ts`: settings cards and slot registration.
- `packages/api/settings-controller/src/index.ts`: namespace description and revisioned writes.
- `packages/client/ui-workspace/src/client/contract/slots.ts`: directory result and project-create input.
- `packages/api/workspace-controller/src/types.ts`: `WorkspaceCreateRequest` and `WorkspaceView`.
- `packages/workspace/workspace/src/index.ts`: create, path uniqueness and recovery.
- `packages/workspace/workspace/src/entity.ts`: Session attachment and directory status.
- `packages/api/session-controller/src/agent.ts`: `createOrAdopt`.
