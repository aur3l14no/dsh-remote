# Repository maintenance

Read README.md, docs/architecture.md and docs/execution-boundaries.md before changing execution or DSH integration. The active implementation plan is .agents/notes/proposed/integration/2026-09-07-world-project-web.md.

- Keep runtime/helper/ independent of DSH. runtime/client and runtime/ssh must not import DSH APIs. DSH-specific plugins, patches, profiles, tests and packaging belong under integrations/dsh/.
- Keep Cargo.lock at the workspace root; root Cargo commands emit to target/. Update imports, manifests, scripts and reproducible checks when moving code.
- Keep subsystem tests and scripts with their owner: runtime/tests and runtime/scripts for generic execution code, integrations/dsh for DSH-specific work. Keep private local configuration in ignored .local/; root justfile optionally imports .local/justfile.
- docs/ explains the maintained architecture and current contracts. Put plans, experiments, acceptance records and changing limitations in .agents/notes/ using its lifecycle conventions. Never describe an unbuilt patch/profile as shipped.
- Keep the upstream revision and applied patch list in integrations/dsh/patches/series.json. Existing unchanged-source tests remain unchanged-source gates; use a separate patched-host gate when patches are implemented.
- Workspace filesystem/process operations use the bound World. Missing routing context fails explicitly. No local fallback, cwd-based World guessing, shell-string rewriting or global Node FS monkey-patching.
- Skill source location does not choose command execution location. Distinguish local connector APIs, local control state and remote workspace capabilities. Keep World facts visible to model/approval; do not add general host-shell authority to fix a local skill.
- Run the focused checks in docs/development.md. Native fixture success is not Linux/SSH or browser acceptance. Do not commit private targets, credentials or runtime tokens.
