# Two-World E2E environment

The host runs DSH, the selected patches/plugins, and the test driver. Docker runs two Linux SSH servers with independent filesystems and Git repositories at the identical path `/workspace`. On macOS use OrbStack; on an Ubuntu runner use Docker Engine with Compose. The Docker daemon must be local to the host running the tests: published SSH ports bind to that host's loopback.

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/e2e.mjs -- node target/patched-host/admission.mjs

# Build the real patched Web host and browser plugins from the clean pinned source.
node integrations/dsh/scripts/prepare-web-host.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/skills-deployment.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs
```

The browser build also requires pnpm (the upstream packageManager pins its version) and downloads Playwright Chromium. On Linux install Chromium system dependencies in the host environment before running the browser lane.

Requires Node 24+, installed npm dependencies, Docker Compose, OpenSSH client and ssh-keygen. The first run downloads Debian/Rust images and Linux packages; subsequent builds reuse Docker's cache. The helper builds inside Linux with the committed Cargo.lock. No host repository, home or Docker socket is mounted into either World. The SSH account is unprivileged; sshd alone starts as root.

The runner creates a unique Compose stack, temporary SSH key, strict known_hosts obtained through Docker control, ephemeral loopback ports, and platform artifact manifest/cache. It verifies both SSH endpoints, exports the configuration below, runs the supplied **host command**, then removes its containers/network and temporary credentials on success, failure or a handled interrupt. Images/build cache remain reusable. SIGKILL or host loss cannot run cleanup: identify the owned `dsh-e2e-*` stack with `docker compose ls` and remove that stack explicitly; do not prune unrelated Docker resources.

| Child environment | Contract |
| --- | --- |
| `DSH_TEST_PORTABLE_WORKSPACE_CONFIG` | JSON `{worlds, path}`: two catalog Worlds, generated SSH configuration, `/workspace` |
| `DSH_TEST_BOOTSTRAP_MANIFEST` | Trusted manifest for the helper and ripgrep extracted from the built Linux image |
| `DSH_TEST_ARTIFACT_CACHE` | Content-addressed artifacts consumed by the production SSH bootstrap |
| `DSH_TEST_WORLD_CONTAINERS` | Test-only Docker control IDs for deliberate World shutdown; never model capabilities |

Paths and keys live under ignored `target/e2e/run-*`. Do not upload that directory as a CI artifact. The runner does not load private `.local/` configuration or host SSH keys. Docker context is restricted by `Dockerfile.dockerignore` to the helper and fixture inputs.

## Browser lane: follow DSH's practice

The pinned upstream uses **Vitest + the `playwright` Chromium API**, not a separate Playwright Test runner:

- `vitest.web.config.ts`: dedicated Web lane, built frontend, serial local execution.
- `apps/web/tests/scaffold.ts`: real Loader/Web composition, HTTP/WebSocket, isolated host state; `extraOverlayPath` and `extraInstallAnchors` compose downstream overlays. Model-dependent scenarios use keyless replay.
- `apps/web/tests/workspace-management.e2e.ts`: role/label-based page interaction with assertions against durable host state.
- `apps/web/tests/web-search-round.e2e.ts`: actual search provider wired to a controlled local HTTP endpoint; a useful reference for the mandatory local connector / remote workspace boundary case.
- `apps/web/tests/support.ts`: English browser context and failure screenshots; scaffold supplies console tripwires and stable ARIA snapshots.

Our browser scenarios belong here, use that same Vitest/Playwright approach, and run as the host command inside this wrapper. The remote overlay must replace local workspace consumers before the scaffold creates Agents. Use the patched checkout, never silently run a clean upstream host and label it patched acceptance. Chromium and the built Web client are host dependencies, not World image dependencies.

Both controller/SSH and browser/SSH lanes are executable. `portable-workspace.e2e.ts` runs the actual product UI, real providers and native model replay. It checks two Worlds at the same path, remote file isolation, local search network/credential boundaries, native fork, cold deep-link recovery with a new runtime, remote process cancellation, missing bindings and a stopped World. It also covers workspace management, remote project/nested instructions, World-specific skill catalogs and updates, deployed skill script execution, remote file completion, and background job ownership/cancellation. The separate deployment lane checks repeated installation, content updates, empty directories, missing prerequisites and refusal to overwrite unmanaged entries.

`scaffold.patch` only extends the upstream test scaffold with externally owned persistent host state and optional directory picking. It is not a runtime patch and is not in `series.json`. `vitest.config.ts` retains the upstream Vitest lane and maps downstream external DSH imports to the same source identities as the scaffold; mixing built/source scope singletons would invalidate routing tests.

Preparation exports a fresh disposable checkout to `target/web-host`, verifies and applies every series digest, installs the upstream lockfile, runs its full build, and installs Chromium. Git discovery is bounded so neither patch application nor upstream install hooks can act on the enclosing repository. Generated packages declare only their actual external/preset dependencies and use the upstream browser module protocol.

The browser runner keeps host control state under `target/web-acceptance/run-*` and removes it after the test. Screenshots are written to `target/web-*.png`. Never upload temporary state, bindings, SSH keys or artifact caches. Controlled model/search responses prove integration behavior, not external service availability or live model quality.

Browser acceptance must cover two Worlds at the same path, selecting/creating Sessions, independent remote writes, page reload and cold host restart, binding errors, cancellation/disconnection, and local Web Search followed by remote file operations. Replay controls model output only; filesystem/process/SSH and browser transport remain real. Remote worktree orchestration remains deferred.

## Native source installation and live checks

`web-e2e.mjs --live PRIVATE_DEEPSEEK_HOME` keeps the real model and external DeepSeek search provider; its task data are generated in fresh Docker Worlds. Only `refs.DEEPSEEK_API_KEY` is read and injected into the host. This is a manual credentialed lane, separate from keyless CI.

`source-install.mjs [PRIVATE_DEEPSEEK_HOME]` requires a `prepare-web-host.mjs --production` build (`scaffold: false`). It invokes the installed native CLI, follows the first-run welcome flow and creates a remote Session with Playwright. The optional credentialed variant also asks the real model to write/execute a remote test, independently reruns it and checks the other World remains unchanged. No fixture host or test-only Loader alias is used. CI runs the keyless variant after a production rebuild. Source-profile dependencies are explicitly linked at the native profile anchor.

Sanitized results are `target/web-acceptance/live-result.json`, `source-install.json` and `source-install-live.json`. The private CLI diagnostic log may contain its process-token URL and is never an uploaded artifact. Temporary homes and Docker resources are removed after acceptance. Local success does not claim a GitHub runner result.
