# Helper implementation and platform acceptance plan

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

Status: helper 0.1.0 baseline and helper 0.1.1 client milestone accepted on 2026-09-05. Both versions passed all 13 executable behavior groups on each of the three specified platforms (39 platform-group passes per version). The Linux runs used system SSH and checksum-verified uploaded artifacts. The additional 0.1.1 client/DSH evidence is recorded in [client.md](client.md) and [milestone results](evidence/client-acceptance-results.json).

Hostnames, SSH aliases, IP addresses, account names, and target-specific workspace paths are execution inputs kept outside repository artifacts. Documentation, source, fixture names, and saved reports identify platforms only. Do not embed the private platform-to-host mapping, including in ignored machine-local documentation or recipes.

## Delivery gates

1. **API and semantics review — complete:** the approved revisions bind processes to the runtime, keep text edit rules local, scope cleanup facts, and require bounded backpressure/replay. See [helper-api.md](../../../../docs/reference/helper-api.md).
2. **Message format and implementation — complete:** revision 1 uses big-endian length-prefixed JSON, Base64 bytes, multiplexed responses/events, ordered resource input, same-session deduplication and explicit output acknowledgements. OS modules remain separate from protocol/runtime dispatch.
3. **Platform acceptance — complete for the executable baseline:** the same 13 groups passed on embedded Linux/musl, containerized Linux/glibc, and native macOS. The later client milestone verifies a minimal DSH provider composition; broader stress/fault cases and full Agent/application integration remain unverified.

User confirmation authorized implementation and the platform acceptance below. The helper milestone does not establish DSH adapter compatibility.

## Inspected platform matrix

| Platform category | Observed architecture / ABI | Observed facilities | Acceptance emphasis |
| --- | --- | --- | --- |
| OpenWrt-family embedded Linux | ARM64 / musl | `/bin/sh`, BusyBox-style system environment, `/dev/ptmx`, `/dev/pts`, readable `/proc/self/stat`; no Bash, ripgrep, Cargo, or rustc found on PATH. | Target-native uploaded binaries, no remote compiler or GNU-tool dependency, filesystem publication, process-group/session handling, memory/output limits. |
| Podman-container Linux | x86_64 / glibc 2.39, Ubuntu 24.04 family | Shell, Bash, ripgrep, Cargo/rustc, PTY devices, readable `/proc/self/stat`. | Actual container process visibility and permissions, PTY job control, cleanup, large output, native Linux build/test reference. |
| Native macOS | ARM64 / Darwin, macOS 26.5.1 | Rust/Cargo 1.95.0 observed; Linux `/proc` is not part of this platform. | Same helper API over an explicitly selected native process, native PTY/process inspection, filesystem/path differences, byte-stream behavior. |

These observations establish a test matrix, not capability proofs. PTY allocation, permission-sensitive foreground inspection, process-tree quiescence, writable scratch storage, executable mounts, and filesystem atomic publication are verified by behavior tests. Containerization is part of the supplied environment classification; do not infer namespace or privilege configuration from the distribution name alone.

Use appropriate target-native helper and ripgrep artifacts. A static musl Linux build is a candidate for the embedded target, with actual executable/PTY tests required. The glibc container is a distinct acceptance target even if a static artifact also runs there. macOS uses a native Darwin build. Pin artifact versions and record digests and Rust target triples in results once selected; do not guess them from the local build platform.

## Test execution

- Use a small client independent of DSH/model calls to exercise the real helper executable. Add adapter/composition checks separately where DSH behavior cannot be verified by the helper alone.
- Configure a platform label, transport target, and scratch/build paths as runtime inputs. The checked-in runner must not contain real endpoint values. Redact endpoint/account/path mappings from saved SSH diagnostics and reports.
- Native macOS explicitly launches the native helper. Remote Linux explicitly launches through SSH. A connection, capability, or exec failure fails that target; no local test is substituted.
- Build/install large dependencies on the designated Linux development environment where practical. Upload artifacts to the embedded target without installing its toolchain. Use isolated temporary test directories and only resources created by the test run; source synchronization must not overwrite an existing unrelated tree.
- Create process fixtures controlled by the tests, rather than depending on a shell feature that one platform lacks. Bash-dependent DSH consumer checks are separate from the baseline helper's argv and PTY contract. Do not install Bash on the embedded platform to disguise such a dependency.
- Track every spawned fixture resource for cleanup after success or failure. Permission tests must not silently pass because the runner happens to be privileged; use a supported restricted fixture identity or record the case as unverified with a reason.
- Select small explicit budgets for resource-limit tests. Use deterministic barriers/hooks for race cases instead of hoping that arbitrary sleeps hit the intended window.

## Shared behavior coverage goals

| Area | Cases | Pass criterion |
| --- | --- | --- |
| Initialization | Compatible/incompatible API revisions, required capability absent, invalid cwd/limits, duplicate initialization. | Refuse incompatible work before side effects; report actual platform/capability facts. |
| Paths | Absolute/relative resolution, symlink aliases, missing nested suffix, dangling links, cycles, spaces and Unicode, invalid NUL/path encoding. | Stable target coordinates without accidental host-path interpretation or lossy name collisions. |
| Metadata/listing | File/directory/link/special entries, no-follow behavior, missing paths, concurrent entry removal, ordered listing. | Correct absence/error distinction and complete deterministic results without reading file contents. |
| Reads | Empty/text/binary files, binary NUL/invalid UTF-8 preservation, non-regular files, exact byte limit and growth beyond it, cancellation mid-stream. | Preserve bytes; text validation belongs to the adapter; no silent truncation or control-loop blockage. |
| Write publication | Unconditional write, create-if-absent race, permissions, symlink target, missing parent directories, pre/post-commit cancellation. | Atomic content visibility and correct committed/cancelled outcome; guarded creation never overwrites a concurrent create. |
| Publication guards | Expected-version success/stale/absent; concurrent staged writes to the same target. | Exactly one guarded publication succeeds for a shared observation. Local match/newline/diff parity is deferred to adapter acceptance. |
| Spawn | Explicit argv/cwd/env, literal metacharacters, executable resolution, missing/nonexecutable program, allocation cancellation, remote ambient credential scrub with explicit overrides/deletions. | No implicit shell or local environment; no leaked provisional child. |
| Input/output | Binary-safe stdin/stdout/stderr, finite stdin plus EOF, interactive writes, slow readers, early child exit, partial write failure. | Ordered bytes, stream separation, bounded queues, no unacknowledged automatic retry. |
| Collection/spill | Independent offsets, tail overflow, mid-character tail, exact spill cap and overflow, storage failure, post-exit reads, process release. | Honest byte offsets/gaps and only valid complete spill paths; retained state stays within budgets. |
| Completion | Root exits while descendants run or hold descriptors; output drain deadline; collect finalization versus root exit. | Distinguish root exit, output closure, and tree quiescence; no indefinite outcome wait. |
| Signals/termination | TERM-compliant and TERM-ignoring children, stopped groups, foreground signals, repeat termination, late control after release, other-owner processes. | Remote escalation and identity-safe targeting; no unrelated process is signalled. |
| PTY | Terminal allocation/controlling session, initial dimensions/resize, merged output, foreground group changes, job control, queued output at exit, write/inspect races with termination. | Real terminal behavior and awaited observable session cleanup; no pipe pretending to be a PTY. |
| Optional input proof | Available positive evidence and unavailable/permission-denied observation. | Never infer waiting from silence; unsupported proof is reported unknown. |
| Connection failure | EOF and lost transport during allocation/write/cancel/output; silent half-open peer beyond lease; reconnect and old handles. | Preserve live-runtime resources during grace; deduplicate same-session retransmissions; expire and clean up afterward; reject old references in a fresh runtime. |
| Limits | Concurrent operation/process ceilings, large directory/mutation, output pressure while cancelling or pinging. | Explicit resource errors and responsive controls; no unbounded retention. |
| Search | Upload a pinned native ripgrep even when a system copy exists; run glob/grep argv, no matches, bad pattern, overflow, cancellation, missing/corrupt artifact. | Search executes in the selected platform using the managed binary; errors remain visible. |

The table above is the broader coverage goal, not a claim that every race or failure branch was exercised. The executable suite and measured results below identify actual coverage. Saved results identify whether a case passed, failed, or remains unverified. An optional unavailable feature can satisfy its declared unavailable branch; a missing required capability is a failure for the promised platform profile. Baseline pipe/PTY behavior must pass on all three platforms before claiming cross-platform helper acceptance.

## DSH integration checks after helper acceptance

| Contract | Required integration evidence |
| --- | --- |
| Filesystem results | Map opaque target/version data and errors; compare newline/edit/diff fixtures with the pinned DSH behavior. |
| Synchronous subprocess handle | Return a provisional handle without blocking, handle cancellation before publication, and publish the real PID after remote start. |
| Synchronous collected `readFrom` | Read only the local mirror of remote observations; finalize it before settling `done`. Verify independent byte offsets. |
| Process lifecycle | Keep `done` separate from `waitForExit`; disposal observes cleanup and does not affect another owner. |
| Terminal | Map allocation-only cancellation, foreground signals, unknown input proof, and awaited terminal termination. |
| Search executable mapping | The real DSH search consumer resolves its packaged executable and the adapter substitutes only the registered managed-ripgrep identity. Remote cwd, argv, limits, and cancellation are preserved. |
| No local fallback | Place different sentinel content at test-controlled local/remote coordinates and induce remote failures; verify no local read/write/search/spawn occurs as a fallback. |

## Report content

Record platform/architecture/ABI, artifact digests and API revision, capability report, test case outcomes, peak memory and spill usage for bounded-output cases, and cleanup results. Store sanitized evidence for failures. Keep real connection targets and their mapping out of reports, example commands, source, and documentation.


## Historical helper 0.1.0 acceptance, 2026-09-05

The machine-readable [acceptance results](evidence/acceptance-results.json) record source/suite fingerprints, Rust versions, artifact SHA-256 digests, platform/ABI, transport, passed groups, and limitations. The remote build source fingerprint matches the local source. No connection target, account name, or target-specific path is stored there.

| Platform | Helper target / artifact | Transport used for final suite | Result |
| --- | --- | --- | --- |
| Native macOS ARM64 | `aarch64-apple-darwin`, native debug build, Rust 1.95.0 | Explicit native runtime and stdio bridge | 13/13 groups passed |
| Container Linux x86_64 / glibc 2.39 | `x86_64-unknown-linux-gnu`, release, Rust 1.96.0 | Uploaded helper/fixture/ripgrep, system SSH stdio bridge | 13/13 groups passed |
| Embedded Linux ARM64 / musl | `aarch64-unknown-linux-musl`, statically linked release, Rust 1.96.0 | Uploaded helper/fixture/ripgrep, system SSH stdio bridge; no SFTP, compiler or Bash installation | 13/13 groups passed |

`cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` passed on the native build, and Linux Clippy passed in the build container. Behavioral coverage is the Python protocol suite with the Rust fixture; `cargo test` currently contains no Rust unit tests and is not the behavior evidence.

The executed groups are:

| Group | Observed behavior |
| --- | --- |
| `handshake` | Reject incompatible API, missing required capabilities, competing controllers, and bad resume tokens; invalid shutdown arguments do not close the runtime. |
| `filesystem` | Binary/multi-chunk reads and publications, exact read cap, absent/version conflicts, canonical paths and symlinks, complete sorted listing, rejection of directories/devices/FIFOs, two staged writes sharing one version. |
| `pipes` | Binary finite stdin/EOF, separate stdout/stderr, literal argv metacharacters, explicit env overrides/deletion, missing executable and invalid relative executable errors. |
| `input_ordering` | Twenty queued writes followed by EOF preserve wire-admission order. |
| `collection` | Bounded byte tail with gap/offsets, full spill at its exact cap, unavailable partial spill after overflow. |
| `backpressure_resume` | A 4 KiB unacknowledged ring stops a 1 MiB producer before its completion marker; controls remain usable; reconnect retains the same output and all bytes are recovered. |
| `dedup` | Repeated and reconnected spawn request IDs execute once; changed content conflicts; eviction returns expired without executing again. |
| `termination` | TERM-ignoring process escalates to KILL; root exit and bounded output closure do not hide an observable living descendant; descendant cleanup completes after termination. |
| `pty` | Real controlling terminal, initial/changed dimensions, foreground group lookup, byte input, unsupported half-close, and foreground INT. Exact input-wait proof reports unknown. |
| `cancellation` | A blocked stdin request is cancellable without implicitly terminating its process; explicit termination performs cleanup. |
| `search` | Deployed target-native ripgrep returns structured matches, no-match exit 1, and invalid-pattern exit 2 through the helper subprocess API. |
| `lease` | Output does not renew inbound lease; an idle transport closes while stdin is open, and reconnect within grace retains the process. |
| `grace_cleanup` | Grace expiry cleans up and removes the runtime socket; replacement runtime has a different identity and rejects old process references. |

Search artifacts are pinned to [ripgrep 15.2.0](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0), with native Darwin, ARM64 musl and x86_64 musl binaries. Archive hashes were checked against official release metadata; SSH uploads were checked again by binary SHA-256. The container's existing system ripgrep was not used for these tests.

During acceptance, the suite exposed and verified fixes for Darwin process-inspection scope, the Linux/Darwin PTY API signature difference, and bridge shutdown/flush behavior when stdin remains open. The final results above use the corrected build.

At this baseline, unverified areas included restricted-account permission failures, exhaustive pre/post-commit and PID-reuse races, hostile external writers, crash durability, actual peak RSS, spill storage failure injection, full interactive-shell foreground job switching, and external DSH composition. The later client milestone adds minimal composition evidence; the other limitations remain. Deliberately escaped descendants and recovery across helper restart are outside the V1 supervision promise. Exact terminal input-wait detection is unavailable by design.

## Reproduction

Build with `cargo build --locked`, or use `sh helper/scripts/build-linux.sh TARGET` on a Linux build machine with that Rust target installed. Use `python3 scripts/upload-artifacts.py --ssh "$TARGET" --destination "$ARTIFACT_DIR" --helper "$HELPER" --fixture "$FIXTURE" --rg "$RG"` to upload into an existing dedicated test directory over SSH stdio. Actual target values are execution inputs, not repository configuration.

Run `python3 helper/tests/acceptance.py --helper "$HELPER" --fixture "$FIXTURE" --platform macos --rg "$RG"` for an explicit native runtime. For Linux, add `--ssh "$TARGET"`, select `--platform linux-container` or `linux-embedded`, and pass the uploaded absolute artifact paths. `--report` writes only platform-oriented results. Each run creates a unique temporary workspace and cleans up its runtime/managed fixtures on success.

`--grace-ms` sets the finite disconnect budget, including the expiry-cleanup test's wait. Its default is 1800 milliseconds; the 0.1.1 container run used 10000 milliseconds for a multi-hop SSH route.
