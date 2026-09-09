# World-aware portable_workspace experiment

The public service is `worldPortableWorkspaces`, with `WorldPortableWorkspaceRegistry`, `startPortableWorkspaceSession` and `openPortableWorkspaceSession`. The three v1 storage identifiers in `registry.ts` remain unchanged for saved metadata and immutable Session bindings; renaming this concept does not create a new storage domain or rewrite saved identities.

Source-only experiment against the unchanged DSH revision pinned in [series.json](../../patches/series.json). Not shipped in the SSH plugin tarball and not a complete Web profile.

It replaces the local Workspace registry, persists World-qualified portable_workspace in a separate storage domain, validates paths through remote providers, and prepares bindings before ordinary Agent create/resume. Two Worlds with the same path remain distinct. The fixture also proves unchanged Web can adopt prepared live Sessions and reproduces direct creation's local mkdir and unprepared cold activation failure.

The registry module re-exports the maintained plugin implementation; there is no second registry. The experiment preserves unchanged-source creation and cold-activation failure cases. The shipped extension supplies management UI/feed and admission through plugins and patches; this fixture does not establish those capabilities or browser acceptance. Keep it as an upstream compatibility gate, not an alternative installation path.

Run from the repository root:

```sh
node integrations/dsh/scripts/check-composition.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" portable_workspace
DSH_TEST_RG="$LOCAL_RG" node target/composition/portable_workspace.mjs
```

The two-container runner is integrations/dsh/scripts/accept-portable_workspace.mjs and requires explicit SSH, cached image, bootstrap manifest/cache and native rg inputs. It creates and cleans only its disposable test containers. See [original evidence](../../../../.agents/notes/archived/2026-09-initial-integration/evidence/project-worlds-acceptance-results.json); it does not establish browser acceptance.
