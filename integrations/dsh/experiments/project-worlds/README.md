# World-aware Project experiment

Source-only experiment against the unchanged DSH revision pinned in [series.json](../../patches/series.json). Not shipped in the SSH plugin tarball and not a complete Web profile.

It replaces the local Workspace registry, persists World-qualified Projects in a separate storage domain, validates paths through remote providers, and prepares bindings before ordinary Agent create/resume. Two Worlds with the same path remain distinct. The fixture also proves unchanged Web can adopt prepared live Sessions and reproduces direct creation's local mkdir and unprepared cold activation failure.

The experiment is input to the [active patched-Web plan](../../../../.agents/notes/proposed/integration/2026-09-07-world-project-web.md). Rename/delete/reorder/archive, live membership/feed, UI and transparent activation are incomplete. Keep native Agent/Session ownership; do not turn this experiment into an independent harness.

Run from the repository root:

```sh
node integrations/dsh/scripts/check-composition.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" project-worlds
DSH_TEST_RG="$LOCAL_RG" node target/composition/project-worlds.mjs
```

The two-container runner is integrations/dsh/scripts/accept-project-worlds.mjs and requires explicit SSH, cached image, bootstrap manifest/cache and native rg inputs. It creates and cleans only its disposable test containers. See [original evidence](../../../../.agents/notes/archived/2026-09-initial-integration/evidence/project-worlds-acceptance-results.json); it does not establish browser acceptance.
