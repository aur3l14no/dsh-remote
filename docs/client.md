# TypeScript client and external composition milestone

The client and supplied-runtime SSH transport work against helper 0.1.1/API 1. A source-based external Cordis Loader fixture verifies minimal DSH filesystem/subprocess providers and the real DSH `runRipgrep` consumer. It uses DSH revision `d347e703908d0406b7a7ef80e3a0e594d86b2215` without core edits. The matching `0.1.3-alpha.1` subprocess package was unavailable from npm during this work; a source composition does not establish independently installed package compatibility.

## Implemented boundary

| Component | Behavior |
| --- | --- |
| `packages/client` | Node 24 ESM TypeScript, strict bounded framing, safe integer/Base64 checks, hello/capability validation, multiplexing, heartbeat, same-epoch reconnect, exact request journal, files, process handles, raw iterators and collected rings. |
| `packages/ssh` | System OpenSSH argv and separately quoted POSIX control arguments; existing SSH configuration, authentication and jumps remain in use. Supports supplied runtimes and the later manifest/cache-based bootstrap described in [bootstrap.md](bootstrap.md). |
| `packages/dsh-ssh` | Experimental external Cordis runtime owner, FS provider, provisional pipe/collection subprocess provider and exact configured executable mapping. All workspace I/O goes through the client. |
| `tests/integration` | Real Loader entry groups read from `cordis.yml`, scoped providers, guarded file edits, actual DSH search with its unchanged 20 MB budget, completed-slot reuse, independent owners sharing a World, separate Worlds and inactive-consumer rejection. |

The composition takes a negotiated client through `worldPlugin(client)`. It loads runtime, providers and consumers in the same isolated realm. Runtime teardown awaits registered provider owners before closing the helper; disposing one subprocess provider cleans only its allocations. Completed collection handles keep their local bounded results while remote slots are released. Raw handles retain the remote resource until consumption finishes or the owner is disposed. Remote cleanup retains the helper's observed-session-members limitation.

The exact packaged-ripgrep identity is an explicit map key; arbitrary executables named `rg` are not rewritten. Fixtures exercise both DSH's bundled-sidecar resolver and the [ordinary npm resolver](packaging.md), preserving argv including `--no-config`. Complete installed-app compatibility remains open. FS target keys include both World and runtime identity, reject cross-World/epoch use and do not imply that host paths name remote files.

## Client behavior and budgets

The states are `starting`, `ready`, `reconnecting`, `closing`, `closed`, and `failed`. A transport factory reconnects to the same socket only. Runtime/token credentials remain private controller memory and are excluded from `client.info`; there is no automatic new-runtime recovery. If the first hello response is lost, startup fails without submitting workspace commands. Invalid frames and unsupported numeric precision fail explicitly. Both incoming and outgoing protocol integers must fit JavaScript's safe range; decimal/exponent wire numbers are rejected instead of rounded.

Requests use monotonic IDs. The client keeps exact serialized bytes until the outcome is observed, then discards its journal entry. Reconnection retransmits those bytes in original order with the same IDs. A remote `REQUEST_EXPIRED`, conflict or resource error is returned to the caller and is never converted into a fresh-ID retry. Unobserved pending requests after permanent transport loss reject with `OUTCOME_UNKNOWN`, carrying the original request ID. Shutdown response loss is likewise an unconfirmed outcome, not proof of cleanup.

Local limits are 24 ordinary and 8 control requests, and a 4 MiB journal plus 256 KiB reserved for control traffic. At most 32 high-level `requestWhenReady` calls may be waiting or admitted, plus 8 reserved for controls. Cancellation fan-out uses at most two control slots at once. `requestWhenReady` retries only local pre-admission congestion; it does not re-execute a remotely admitted operation. Process input queues reserve at most 1 MiB per handle and send 32 KiB chunks in order. A failed chunk reports the fully completed prefix and the chunk's partial/unknown details. EOF remains possible after a failed write.

Raw iterators request bounded chunks and acknowledge each chunk when the consumer asks for the next one. Receiving an event never acknowledges data. Pipe adapters place only bounded data in a Node `Readable`. Collections merge original byte offsets, discard replay overlap, report tail gaps and finalize through the remote produced offset before resolving `done`. Local mirrors are bounded per handle by the requested collection size; callers own how many completed handles/results they retain. The helper separately reserves at most 64 MiB across live output buffers.

FS reads/uploads have a 64 MiB client bound; the experimental FS provider explicitly configures text and diff-basis limits. Listings fail beyond 1000 entries. Text decoding, NUL rejection, literal matching, CRLF/LF handling and before/after diff bases run locally. Remote version checks and atomic publication protect edits. A committed write with unavailable post-publication metadata reports `COMMITTED_UNOBSERVED` as the FS error cause and must not be retried automatically. In 0.1.1 a guarded create observes its version after removing the staging hard link, avoiding an immediately stale result.

The subprocess adapter rejects grace periods above 30 seconds and output/spill caps outside advertised support. The subsequent [terminal milestone](terminal.md) enables PTY allocation. It does not silently clamp a consumer request. Finite stdin follows DSH's best-effort contract; explicit pipe writes preserve input errors, and actual process exit/output determines the batch outcome. A lost runtime does not synthesize exit facts.

## Reproduce

Build the native helper first, then use Node 24 or later:

```sh
cargo build --locked
npm ci --ignore-scripts
npm run check
npm test
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE"
DSH_TEST_RG="$NATIVE_RG" node target/composition/run.mjs
```

`DSH_SOURCE` must be the unmodified pinned checkout with the required source packages/vendor files present. The build script verifies HEAD and tracked cleanliness; it bundles the actual source and its package-version metadata. The type check validates our providers against pinned source interfaces; it does not run DSH's whole-repository check. No runtime credentials or connection coordinates are embedded into the fixture or build.

`npm test` runs the local protocol/client tests and explicitly skips the SSH case unless a target is supplied. Override `DSH_TEST_HELPER`/`DSH_TEST_FIXTURE` to test other native artifacts. The SSH case requires `DSH_TEST_HOST`, `DSH_TEST_REMOTE_HELPER`, `DSH_TEST_REMOTE_FIXTURE`, and `DSH_TEST_REMOTE_RG`; `DSH_TEST_SSH_CONFIG` optionally selects an SSH config file. It creates a private remote test workspace and starts the supplied helper there. Run only that case with `node --test tests/client/ssh.test.ts`. A failed target does not select a local helper.

The same SSH variables select remote execution for `node target/composition/run.mjs`, while `DSH_TEST_RG` still identifies the local bundled-sidecar fixture. The DSH Loader, providers, text editing and search consumer run locally; workspace files, ripgrep and subprocesses run in the selected helper. Setup explicitly starts two supplied runtimes in temporary directories; this test setup is not a production bootstrap implementation.

## Measured acceptance, 2026-09-05

The [milestone results](client-acceptance-results.json) record exact source/suite fingerprints, artifact digests, platform labels and scope. Helper 0.1.1 passed the 13-group protocol suite on all three platforms. Native client tests passed 14 cases on macOS ARM64 and container Linux x86_64; each native run intentionally skipped the separately configured SSH case. That SSH case passed independently against embedded Linux ARM64/musl and container Linux x86_64/glibc.

The real source-based DSH Loader composition passed on native macOS and with the local macOS harness connected by system SSH to each Linux platform. It exercised guarded CRLF edits, a 17,525,000-byte search result using the unchanged 20,000,000-byte limit, exact executable substitution, explicit missing-artifact failures, post-exit collection, process-slot reuse, independent provider owners and separate Worlds. Remote file coordinates were also absent locally. These are provider/consumer checks, not an Agent or full-application acceptance claim.

The container helper suite used a 10-second reconnect grace to accommodate multiple SSH handshakes; the other helper suites used 1.8 seconds. The expiry-cleanup test used each configured deadline. This verifies finite grace under those conditions, not a guarantee that arbitrary SSH routes reconnect within the default budget.

## Remaining work

This Loader fixture proves provider behavior, not a complete application. The [preset composition](agents.md) uses unchanged DSH Agent/tool/subagent services; the [persistent router](session-routing.md) adds an external Session–World map and DSH JSONL restart validation. Actual terminal/job consumers are application fixtures. The [plugin tarball](packaging.md) is tested with a source-built host; installed public DSH compatibility remains open.

The subsequent [bootstrap milestone](bootstrap.md) implements manifest/cache-based installation, startup, upgrade coexistence, corruption repair and offline provisioning. `connectSuppliedRuntime` still only connects to an existing runtime; automatic provisioning uses the separate `bootstrapSshWorld` entry point. Trusted release downloads and distribution remain open.
