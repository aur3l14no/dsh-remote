# World-aware Project experiment

Source-only, against unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. Not included in the SSH plugin tarball. This exercises the actual Workspace service contract, Agent registry/loop, standing presets, JSONL persistence and Web activation controllers. It is **not a browser test or a complete Web plugin**.

## Implemented

- Replace the local Workspace registry with a Project service. Its initialization never opens the built-in workspace domain or indexes remote Session paths locally.
- Resolve and check directories through a concrete Execution World before registering `(catalog World ID, canonical path)`.
- Store Project metadata in a separate DSH storage domain. Catalog entries describe environments; each Project receives a concrete workspace binding ID. Existing v1 World/Session bindings are unchanged.
- Prepare and bind before calling public `agents.create()` / `agents.resume()`. One standing preset serves every World. Web's existing activation controllers can adopt the resulting live Session.
- Reject cross-World attachment and removed/changed catalog connections. Retain visible Project identity across restart even when its World is unavailable.

The registry subclasses DSH's concrete `WorkspaceRegistry` solely to satisfy its nominal service type. It overrides initialization and every public operation; it never accesses the base class's private fields. Rename, delete, reorder and archive explicitly reject as outside this experiment. Membership is a candidate account revalidated on open/attachment; full live membership filtering is not implemented. A production Project feed and UI would belong to this separate plugin.

## Confirmed boundary

The fixture also invokes the **unchanged** controllers behind Web Session creation/activation:

1. Creating through the Project entry and then adopting an explicit live Session ID works.
2. Restarting, opening through the Project entry, and then adopting the resumed Session works.
3. Creating directly through the unprepared Web route executes local `mkdir(cwd)` before World admission. The test confines this side effect to its own temporary directory.
4. Cold Web activation cannot prepare a World. It fails before Agent publication with the existing World guard. Typert rejects a second resolver for the Session Controller's owned Agent lookup.

These observations do not establish that all external integration strategies are impossible. They establish that replacing the Project registry/picker and adding a Project entry is insufficient for transparent Web integration. The Web history follower also promotes cold Sessions through its internal activation controller, so overriding only the public `resolveAgent()` method would not cover every entry.

Stop at this seam: no Agent factory wrapper, replacement Session Controller, private-field access, filesystem monkey-patch, fake local workspace or eager resume of all stored Sessions. No Project settings card or chat UI has been shipped. A suitable upstream extension would await environment preparation before **every** create/resume path (including history promotion and upload resolution), permit World-owned directory validation, and propagate preparation failure before local directory mutation/publication.

## Reproduce

Build with the pinned, unmodified DSH checkout (including the `workspace`, `storage`, `session-query`, `typert` and `api` source groups):

```sh
node scripts/build-composition.mjs "$DSH_SOURCE" project-worlds
node scripts/check-composition.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" node target/composition/project-worlds.mjs
```

Native macOS acceptance passed. It uses two helper runtimes with the same directory to test qualified identity and native DSH composition, not filesystem isolation. The [Linux/glibc two-container run](../../docs/project-worlds-acceptance-results.json) also passed, including distinct file contents at the same path and cleanup of both containers.

To verify actual isolation, select a Linux SSH entry with rootless Podman and a cached compatible image; supply connection facts only through private local environment/configuration:

```sh
DSH_TEST_HOST="$SSH_ENTRY" DSH_TEST_SSH_CONFIG="$PRIVATE_SSH_CONFIG" \
DSH_TEST_CONTAINER_IMAGE="$CACHED_IMAGE" \
DSH_TEST_BOOTSTRAP_MANIFEST="$ARTIFACT_MANIFEST" \
DSH_TEST_ARTIFACT_CACHE="$ARTIFACT_CACHE" DSH_TEST_RG="$LOCAL_RG" \
  node scripts/accept-project-worlds.mjs
```

The runner creates two temporary, network-disabled containers without SSH servers, pins their full IDs, and supplies their catalog through a private temporary file. Both contain the same workspace path with different file contents. It verifies that this path never exists on the local host or SSH entry, runs create/restart/configuration-loss phases, and removes both containers. The resulting platform-only evidence is written to `target/project-worlds-acceptance.json`.
