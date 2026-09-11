# Repository maintenance

Before changing execution or DSH integration, read README.md and docs/system-map-1.md. Active plan: .agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md.

- This is personal research with no users. Support one pinned DSH baseline and the current state format; remove obsolete migrations and internal compatibility aliases instead of preserving experimental history in runtime code. Breaking changes require explicit fresh private state, never automatic deletion or rebinding.
- Keep World, Workspace, Session binding and runtime instance identities distinct. Display preferences must not change execution identity or workspace timestamps. Prefer existing UI extension points over cosmetic upstream patches.
- Use the documented check/test/test-integration/test-e2e/package entry points. Share build preparation while retaining independent test state and proof boundaries. Add providers, platform matrices and product lifecycle features only for a concrete research need.

- Keep runtime/ DSH-independent; DSH-specific code, tests and packaging belong in integrations/dsh/. Generic tests and scripts belong in runtime/tests/ and runtime/scripts/.
- When integrating with DSH, prefer composable approaches that minimize coupling to upstream internals and survive upgrades, such as plugins over patches where both meet the requirements.
- Keep the standalone Cargo manifest and lockfile in runtime/helper/; run Cargo there with its default target/. No root target/ or compatibility alias.
- Workspace filesystem/process operations use the bound World; missing routing context fails explicitly. No local fallback, cwd-based World guessing, shell-string rewriting or global Node FS monkey-patching.
- Skill location grants no execution authority. Keep local connectors, local control state and remote workspace capabilities distinct, with World facts visible to model/approval. Do not add general host-shell authority for local skills.
- Track upstream revision and applied patches in integrations/dsh/patches/series.json. Preserve unchanged-source gates; validate patches through a separate patched-host gate. Use focused checks from docs/development.md; native fixtures do not establish Linux/SSH or browser acceptance.
- docs/ holds current contracts; plans, experiments, acceptance records and changing limitations belong in .agents/notes/ under its lifecycle conventions. Preserve historical evidence paths.
- Private configuration belongs in ignored .local/; root justfile may import .local/justfile. Use .build/dsh/ for disposable builds and private test state, artifacts/dsh/ for sanitized reports, dist/dsh/ for distributions, .build/runtime/ for helper release staging, and dist/runtime/ for helper archives.
