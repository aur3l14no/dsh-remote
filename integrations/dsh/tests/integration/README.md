# Unchanged-source integration fixtures

These fixtures exercise the original DSH interfaces at the revision pinned in [series.json](../../patches/series.json). They do not apply patches or replace installed-package browser acceptance.

`portable_workspace.ts` imports the maintained workspace registry directly. `portable-workspace-entry.ts` supplies explicit bind/create/resume test wiring through native Agent APIs; it is not a product entry or another registry implementation. The fixture preserves direct Web creation and cold-activation failure cases on unchanged source.

Other fixtures cover provider composition, Session routing, Agents and terminal consumers. Commands and required environment inputs are in [development](../../../../docs/development.md). Patched-host checks live separately in `../patched-host/`; official installation and browser/SSH acceptance are under `../packaging/` and `../e2e/`.
