# SSH bootstrap and artifact installation

The SSH package now provisions a World from a caller-trusted manifest and a local artifact cache. It probes the selected host, checks the platform/ABI, installs helper and ripgrep, starts a private runtime, negotiates the helper and validates managed ripgrep through that runtime before returning readiness. Workspace operations continue through the protocol client. A failed SSH target never selects a native runtime.

This is an external-library milestone. It does not publish a binary distribution, download a release catalog, or establish a production DSH application preset. The caller supplies trusted release metadata and cached artifacts; provenance cannot be established from an untrusted manifest merely by checking its hashes.

## Public entry point

```ts
import { bootstrapSshWorld } from '@dsh-remote/ssh';

const world = await bootstrapSshWorld({
  host: selectedSshHost,
  world: immutableWorldId,
  cwd: explicitRemoteWorkspace,
  manifest: trustedManifest,
  cacheDir: localArtifactCache,
  required: ['process.exit-signal-name'],
});

// Pass world.client to the existing external World/provider composition.
// Register only DSH's exact packaged-ripgrep identity -> world.ripgrep.
await world.close();
```

The workspace packages remain private source packages. The example describes their API, not an npm installation claim. `configFile` optionally selects an OpenSSH configuration file. System SSH continues to own keys, ssh-agent, jumps and host verification. Control arguments use POSIX quoting separately from Agent argv; no `shell: true` is used.

`installRoot` defaults to the account's `$HOME/.cache/dsh-remote`; `runtimeBase` defaults to `/tmp`. Both may be set explicitly. The workspace must already exist and is canonicalized remotely. Bootstrap path coordinates must be absolute and exclude NUL and line breaks; spaces, quotes, backslashes and other literal characters are quoted rather than evaluated. An unusable installation root fails explicitly; it does not trigger an undisclosed alternative.

The result exposes the client, selected platform, exact installed helper/ripgrep paths and whether installation was reused. Resume credentials remain inside the client. `close()` confirms runtime shutdown before deleting only that World's private temporary parent. Cleanup failures propagate; they are not reported as successful shutdown.

## Manifest and local cache

Manifest format 1 contains a list of bundles. Each bundle specifies:

- Target OS (`linux` or `macos`), architecture (`aarch64` or `x86_64`) and ABI (`musl-static`, `glibc` with a minimum version, or `darwin`).
- Helper version, protocol API 1, exact byte size and SHA-256.
- Ripgrep version, exact byte size and SHA-256.

Selection requires exactly one compatible bundle. It rejects unknown platforms, an unmet or unobservable glibc requirement, unsupported APIs, malformed metadata and ambiguous selections. The manifest's ABI declaration is a provenance assertion; the installer also executes the checked artifact on the actual target. The accepted x86_64 bundle currently requires glibc 2.39 conservatively; this is not a measured minimum glibc floor for general distribution.

Local cache files are named by their SHA-256. `cacheArtifact` copies an explicitly supplied regular file into private staging, computes its size/hash and atomically publishes the cached file. An optional expected digest/size checks an existing trust assertion. Each artifact is limited to 128 MiB. The installer opens cached artifacts without following a final symlink, hashes the opened file before uploading and independently checks remote bytes before execution. A concurrent mutation cannot make unchecked bytes ready. Reuse validates the remote copy and does not require the original local cache file.

To prepare one platform bundle from known build outputs:

```sh
node scripts/prepare-artifacts.ts \
  --os linux --arch aarch64 --abi musl-static \
  --helper "$HELPER" --helper-version 0.1.1 \
  --ripgrep "$RG" --ripgrep-version 15.2.0 \
  --cache "$CACHE" --out "$MANIFEST"
```

For a glibc bundle, use `--abi glibc --minimum-glibc VERSION`; native macOS uses `--os macos --abi darwin`. The command refuses to overwrite an existing manifest. It records no local artifact paths or connection coordinates in the manifest and never executes a Linux artifact on the local Mac to identify it. Release downloads, publisher authentication, signed catalogs, release ABI coverage and redistribution notices remain distribution work.

## Installation transaction

The installation root and its `generations`, `refs` and `locks` directories must be private directories owned by the SSH account. Final symlinks and unexpected permissions are rejected. The environment needs a POSIX shell and basic utilities (`uname`, `id`, `ls`, `mkdir`, `mktemp`, `cat`, `wc`, `chmod`, `head`, `mv`, `rm`, `rmdir`, integer-second `sleep`), plus `sha256sum` or `shasum`. `getconf` is optional unless the selected bundle requires glibc detection. No remote compiler, package manager, Bash, SFTP, `stat` command or public internet is required.

1. Hash the canonical bundle metadata to choose a reference key. If its current generation passes permission, size, digest and executable-version checks, reuse it.
2. Allocate a unique private generation directory. Stream each local artifact through SSH stdin; do not unpack a remote archive or invoke a remote downloader.
3. Acquire a per-bundle publication lock using atomic directory creation. Retry using integer-second waits up to `lockWaitMs` (default 10 seconds, supported 100–30,000 ms; sub-second remainder is not slept).
4. Recheck the reference under the lock. If another installer already published a valid generation, discard this caller's staging and reuse the winner.
5. Check the staged bytes and executable versions, make the generation read/execute-only, then publish a small reference file by atomic rename. The generation path is never rewritten in place by the installer.

Interrupted uploads do not publish a reference. If the publication response is lost, the caller fails that attempt; the next install rechecks the reference and can reuse the committed generation. Cleanup after publication belongs to the remote transaction, avoiding deletion of a generation whose successful publication was not observed locally.

Repair publishes a new generation under the same manifest key. Upgrades use the new bundle key. Existing Worlds retain their exact helper path, runtime identity and credentials; new Worlds select the newly checked generation. Neither case restarts existing tasks or replays workspace requests into a new helper. Old generations remain available for pinned owners.

External corruption of a pinned executable can still break that World's later execution or reconnect. Repair prepares a valid generation for new Worlds; it does not silently change an existing World's executable identity. The accepted repair test corrupts ripgrep while retaining the live helper and its reconnect path.

## Runtime lifecycle and limits

Each World gets a fresh private temporary parent; the child runtime directory remains absent until `helper start` creates it. Bootstrap rejects socket paths longer than 100 UTF-8 bytes. It validates the negotiated build, platform, architecture, canonical cwd and required capabilities. A managed `ripgrep --version` subprocess must complete through the client before readiness.

Defaults are a 30-second disconnected grace, 10-second inbound lease, and 15-second connect/validation budget. Grace/lease can be configured within the helper's 100–300,000 ms runtime range. These are separate from its at-most-30-second process termination grace. The client heartbeat, exact request journal and same-runtime reconnect remain unchanged. An expired World fails; a new `bootstrapSshWorld` call explicitly creates another runtime.

Control stdout is capped at 64 KiB; stderr is drained without exposing SSH/account diagnostics as protocol data. Control commands and uploads have deadlines; cancellation stops the active control transport. A connect already in progress can take its bounded handshake budget before cancellation is observed. Cancellation after successful readiness does not become a lifetime signal for the World. Managed ripgrep validation has a deadline and cleans its process on failure.

If startup or the initial hello response is lost before credentials are available, bootstrap reports failure and submits no workspace workload. An unbound helper expires after its finite grace. A small temporary parent may remain. The code does not infer successful cleanup from a missing response.

## Acceptance and remaining limits

The executable suite is `tests/bootstrap/install.test.ts`, with shared manifest/cache/control tests alongside it. Explicit native macOS injects a native control/transport pair into the internal resolver seam; the public entry point always uses SSH. Linux runs use `bootstrapSshWorld` and the actual selected SSH targets.

```sh
DSH_TEST_NATIVE_BOOTSTRAP=1 \
DSH_BOOTSTRAP_RG="$NATIVE_RG" \
DSH_BOOTSTRAP_PREVIOUS_HELPER="$PREVIOUS_NATIVE_HELPER" \
npm run test:bootstrap
```

For Linux, supply `DSH_TEST_HOST`, optional `DSH_TEST_SSH_CONFIG`, `DSH_BOOTSTRAP_HELPER`, `DSH_BOOTSTRAP_RG`, `DSH_BOOTSTRAP_PREVIOUS_HELPER` (local target-native files) and `DSH_TEST_REMOTE_FIXTURE` (the already deployed acceptance child). No helper or ripgrep installation is supplied remotely. Upgrade coverage requires an actual helper 0.1.0 artifact; it is explicitly skipped if absent.

The DSH composition fixture accepts `DSH_TEST_BOOTSTRAP_MANIFEST` and `DSH_TEST_ARTIFACT_CACHE` instead of a supplied remote helper/ripgrep pair. Its harness and consumers stay local while helper installation and workspace execution happen remotely. See [measured bootstrap results](bootstrap-acceptance-results.json).

Installation storage is account-controlled, not a sandbox against a hostile process with the same account. Forced termination of the publication shell by SIGKILL can leave a lock: callers fail with `INSTALL_BUSY` rather than stealing an unproven-dead lock. A broken transport may leave unreferenced staging. Automatic garbage collection, recovery of such locks, peak installation disk usage, power-loss durability and hostile ancestor-path races are not established by this milestone. Ordinary signalled termination uses a cleanup trap; old generations are intentionally retained for live owners. These limits do not change the helper's narrower managed-process cleanup promise.

The next stage is creation/resume-time Agent World binding, context and approval metadata, full consumer scoping, PTY/Session jobs, and independently packaged application compatibility. This installer does not establish those contracts.
