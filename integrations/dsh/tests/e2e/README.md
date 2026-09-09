# Two-World E2E environment

Run the setup and gate commands in [development](../../../../docs/development.md#可复用双-world-环境). This page owns the environment contract and test coverage.

The host runs DSH and Vitest/Playwright Chromium. A local Docker daemon runs two Linux SSH servers with independent Git repositories at `/workspace`; use OrbStack on macOS or Docker Engine with Compose on Ubuntu. Published SSH ports bind to the test host's loopback. Node, npm dependencies, OpenSSH and ssh-keygen are host prerequisites; Linux also needs Chromium system dependencies.

The first build downloads Debian/Rust images and Linux packages. The helper builds with Cargo.lock inside Linux. No host repository, home or Docker socket is mounted into the Worlds; the SSH account is unprivileged, and only sshd starts as root. Dockerfile.dockerignore restricts the build context to helper/fixture inputs.

## Runner inputs, outputs and cleanup

`e2e.mjs -- HOST_COMMAND ...` creates a unique Compose stack, temporary key, strict known_hosts obtained through Docker control, ephemeral ports and artifact cache. It verifies both SSH endpoints, then supplies the host command with:

| Environment | Contract |
| --- | --- |
| `DSH_TEST_PORTABLE_WORKSPACE_CONFIG` | File containing JSON `{worlds, path}`: catalog targets, generated SSH configuration and `/workspace` |
| `DSH_TEST_BOOTSTRAP_MANIFEST` | Trusted manifest for helper/ripgrep extracted from the Linux image |
| `DSH_TEST_ARTIFACT_CACHE` | Content-addressed artifacts used by production bootstrap |
| `DSH_TEST_RIPGREP_LICENSE` | License extracted from the image for the complete release candidate |
| `DSH_TEST_WORLD_CONTAINERS` | JSON Docker IDs for deliberate test shutdown; never a model capability |

Private inputs stay under `.build/dsh/e2e/run-*`; the runner does not load personal SSH keys or `.local/` targets. Success, failure and handled interrupts remove the stack, network and temporary credentials; images/build cache remain. After SIGKILL or host loss, identify the owned `dsh-e2e-*` stack with `docker compose ls` and remove it explicitly. Never prune unrelated resources or upload private run directories.

## Gates and proof boundaries

| Gate | Coverage |
| --- | --- |
| patched-host admission | Controller creation/adoption, fork and cold activation over real SSH; separate from browser and model acceptance |
| patched-host attachments | Remote storage, World isolation, native pi-ai request serialization to a synthetic endpoint, image tools, restart/fork, legacy refs and missing/corrupt source rejection over native or Linux/SSH providers |
| `attachments.e2e.ts` | Installed extension with Chromium picking images/files, real upload transport and file/image tools, remote paths, preview, fork and cold restart; uses an image-capable MockAdapter |
| `portable-workspace.e2e.ts` | Product UI and providers with model replay: two same-path Worlds, remote writes, workspace management, fork, cold deep links/new runtime, child continuation, terminal/jobs ownership and cancellation, missing bindings and stopped World |
| instructions/skills and deployment | Project/nested instructions, World catalogs and updates, file completion, deployed scripts; repeated deployment, empty directories, prerequisites and unmanaged-entry conflicts |
| previews and migration | Host/two-World same-path isolation, range reads, Sidebar/images, symlink/out-of-root rejection and change filtering; disposable V2→V3 logs with original bytes and bindings preserved |
| controlled Web Search | Native provider calls the host HTTP endpoint; remote Shell cannot access that loopback endpoint and lacks connector credentials |
| `extension-install.mjs` | Official CLI installs the extension tarball and initializes through init-release, then Playwright exercises first-run welcome, Session creation, automatic/manual sync, failed-source retry and unchanged helper PIDs; no scaffold |

`prepare-browser-fixtures.mjs` copies only pinned upstream tests/replay/mock assets and adds persistent-state/directory-picker options. `installed.vitest.config.mjs` resolves tests to installed official JavaScript; the frontend stays official. The product uses a native overlay and ordinary Node resolution. Replay controls model output; filesystem, processes, SSH and browser transport remain real. Controlled search does not establish external service availability.

## Optional live and recording lanes

`web-e2e.mjs --live PRIVATE_DEEPSEEK_HOME` and `extension-install.mjs [PRIVATE_DEEPSEEK_HOME]` read only `.credentials.yaml` → `refs.DEEPSEEK_API_KEY` into the host. They send synthetic tasks from fresh Worlds; the CLI lane verifies real-model remote execution and isolation of the other World. Commands are in [development](../../../../docs/development.md#真实模型验收). `DSH_TEST_INSTALL` selects a separate official installation.

Set `DSH_TEST_RELEASE_OUTPUT` to an absent directory to retain the complete candidate accepted by extension-install; otherwise its temporary candidate is removed. CI uses this for [release promotion](../../../../docs/release.md). Set `DSH_E2E_VIDEO_DIR` for a 1440×900 WebM of the CLI browser flow; default runs are unrecorded, and SSH assertions remain in the runner.

Browser state lives under `.build/dsh/e2e/browser-*` and is removed after the test. Sanitized screenshots/results live under `artifacts/dsh/`, including `live-result.json`, `extension-install.json` and `extension-install-live.json`. Private CLI logs may contain a process-token URL and must not be uploaded. Local acceptance does not establish a GitHub runner result; outstanding scenarios are maintained only in the [current plan](../../../../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md).
