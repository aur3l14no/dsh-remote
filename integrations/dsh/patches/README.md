# Downstream DSH patches

`series.json` pins the upstream repository/revision and ordered patch paths. `patches: []` means no patch is implemented or applied by this repository. Planned changes live in the [active plan](../../../.agents/notes/proposed/integration/2026-09-07-world-project-web.md), not as fictional entries in the applied series.

When implemented, each numbered patch must state the package, missing interface, preserved local behavior, test command and reason an external provider alone is insufficient. Keep SSH/Project business logic in plugins. Record the exact baseline and patch hashes with acceptance evidence; an upgrade must reapply and retest the series before changing the supported baseline.

Use a separate checkout and patched-host validation entry. Existing scripts intentionally reject modified upstream sources. This directory does not vendor upstream code, modify the user's primary checkout, or assume upstream accepts PRs.
