# SSH → Podman exec transport

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

An optional Podman entry runs the same helper in a running container without installing an SSH server there. System OpenSSH enters the Linux host; `podman exec -i` supplies the final environment's control and protocol streams. Platform probing, helper/ripgrep upload, installation, runtime start, reconnect and cleanup all use that same entry. Neither transport allocates a TTY; the helper allocates requested process PTYs inside the container.

Add `podmanContainer` to an SSH target or saved World definition:

```ts
await ctx.executionWorlds.bind(sessionId, {
  id: worldId, kind: 'ssh', host: sshHost,
  podmanContainer: fullContainerId, cwd: canonicalContainerWorkspace,
});
```

The field requires a full 64-character lowercase hexadecimal container ID. Resolve a user-selected name to that ID explicitly before binding; names and shortened IDs are refused. Removing or replacing the container never reconnects an existing binding into its replacement or onto the SSH host. An explicit new World is required for another container. The optional field is retained by the version-1 binding map; older plugin builds reject maps containing it instead of discarding it.

The SSH account must already be able to use Podman. Execution uses the container's configured user and environment, without sudo, privilege changes, mounts, exposed ports or copied local credentials. A restricted container may reject a helper capability explicitly. Stopping the container stops its runtime; helper restart recovery remains unsupported. The World plugin does not own container creation/removal, images or the Podman daemon.

This is a narrow, experimental SSH entry with one Podman step. A general resolver registry, arbitrary nested chains and container lifecycle management remain outside this implementation.

## Reproduce acceptance

`integrations/dsh/scripts/accept-podman.mjs` requires explicit environment inputs:

| Variable | Input |
| --- | --- |
| `DSH_TEST_HOST` | SSH entry from the operator's private configuration. |
| `DSH_TEST_SSH_CONFIG` | Optional local OpenSSH config file. |
| `DSH_TEST_CONTAINER_IMAGE` | Explicit cached Linux/glibc image with Bash; the runner uses `--pull=never`. |
| `DSH_SOURCE` | Unchanged pinned DSH checkout. |
| `DSH_TEST_BOOTSTRAP_MANIFEST` / `DSH_TEST_ARTIFACT_CACHE` | One compatible Linux bundle and its trusted local cache. |
| `DSH_TEST_FIXTURE` | Local target-native acceptance child binary. |
| `DSH_TEST_RG` | Local carrier's ripgrep for the terminal consumer fixture. |

```sh
node integrations/dsh/scripts/accept-podman.mjs
```

After `pack-plugin.mjs` and `check-plugin.mjs`, run `node integrations/dsh/scripts/accept-podman.mjs --package` with the same inputs to exercise the unpacked plugin's Loader entries and Session routing in a second disposable container. It writes `target/podman-package-acceptance.json` with the tarball integrity and digest.

The runner creates one disposable rootless container using the selected cached image, with networking disabled and no host mounts. It verifies the absence of `sshd`, uploads the acceptance child with a digest check, and runs the existing client, bootstrap, persistent Session routing and terminal suites. The workspace must be absent on both the client machine and the SSH host. It removes its container and verifies further control/bootstrap calls fail. Its result at `target/podman-acceptance.json` records platform and image digest, never SSH coordinates or container IDs. Failed runs do not publish a success report.

These remain source-built DSH fixtures. They do not establish complete Web compatibility, model-driven cross-root orchestration or shared-router terminal initialization; see [demo assessment](demo-assessment.md).

Accepted on 2026-09-06 with Linux/glibc x86_64 and rootless Podman 4.9.3: client and installation suites, five persistent-routing groups, seven PTY/terminal/job groups, and removed-container refusal. Alpha.2 additionally passed all five routing groups through its actual Loader package entries in a second container. Both containers were removed. The additional installation run skipped the previous-version upgrade case. See [artifact hashes and measured results](evidence/podman-acceptance-results.json).
