# Next stage: PTY, Session jobs and complete application composition

Status: client, minimal external composition, and manifest/cache-based SSH bootstrap implemented and accepted, 2026-09-05. Installation and real helper 0.1.0 → 0.1.1 upgrade checks passed on native macOS and SSH-connected embedded/container Linux. See [bootstrap scope and evidence](bootstrap.md), [client scope](client.md) and [client evidence](client-acceptance-results.json). Agent creation/resume binding and a bounded consumer profile are now implemented; see [Agent scope and evidence](agents.md). Complete application integration and trusted release distribution remain open. The original helper baseline is commit `74bf93d`.

## Target outcome

An external DSH composition binds an Agent to an explicit SSH World before publication. One local runtime owner uses system OpenSSH to install/validate target-native artifacts, start or resume the remote helper, and supply the same connection to filesystem and subprocess adapters. A real DSH filesystem/search/process consumer demonstrates remote execution and fails explicitly when the World is unavailable. Model calls, Agent loop, Session persistence, UI and approval policy remain local.

The completed deliverables contain a TypeScript protocol client, SSH installer/runtime bootstrap and an E2B-style Loader composition experiment. Actual FS/subprocess services and the DSH search consumer resolve the isolated providers, including after cold installation from a local cache. The external registry now binds real Agents, shares runtime leases, validates resume, supplies approval metadata and uses a local persistence seam for required World records. Complete application consumers and production distribution still require the work below.

## Source baseline and concrete findings

Use the inspected [DSH revision d347e70](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215) for the first experiment. Its source package version is `0.1.3-alpha.1`; this is not a claim that the corresponding published packages contain every inspected interface. Before integration, record the exact installable dependency versions or build/package this pinned checkout in an isolated dependency environment. Do not edit DSH core to make the experiment pass.

| Evidence | Consequence for the next stage |
| --- | --- |
| [E2B runtime](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/e2b/e2b/src/index.ts) is a Cordis service with one awaited sandbox handle and effect-owned teardown. | Implement one shared SSH runtime service; adapters await its readiness and participate in its lifecycle. Do not start one helper per tool call. |
| [E2B composition fixture](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/e2b/e2b/tests/fixtures/composition/cordis.yml) combines provider services with existing Bash/terminal/LSP consumers. | Reuse this composition-testing shape with our runtime and adapters. A consumer named `*-local` must be inspected by its actual execution path, not classified from its name. Bash-dependent consumers are explicitly unavailable where Bash is absent. |
| [App boot](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/boot/app-boot/src/index.ts) exposes `cordis:group` so a provider and consumers can share an isolated service realm. | Load the complete relevant consumer group into the selected World. Merely attaching providers to an Agent does not prove routing. |
| [Agent creation/resume](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/src/index.ts) awaits `setup` and supports a synchronous publication commit with rollback. | Bind and validate World context while unpublished, including resume. Verify child-Agent inheritance through its actual creation path; do not assume all caller paths already supply the hook. |
| [Search consumer](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/fs/tool-fs-search/src/search-core.ts) exports `resolveRgPath`, passes that exact local packaged path to subprocess, and uses Agent Session cwd or otherwise local `process.cwd()`. | Register only that exact executable identity for substitution with deployed remote ripgrep. Ensure Agent calls carry remote cwd; reject or explicitly bind agentless execution rather than allowing a host cwd to leak into the remote request. |
| [Subprocess contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subprocess/subprocess/src/types.ts) exposes synchronous spawn handles and collected `readFrom`, with separate `done`/`waitForExit`. | Build provisional local handles and a bounded local mirror of remote observations. Keep root exit, final stream installation, cleanup, and transport failure distinct. |
| [Filesystem contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/fs/fs/src/types.ts) requires versions, guarded writes and before/after text results. | Keep text matching/newline/diff work local; publish bytes remotely against the observed version. Preserve committed-but-unobserved outcomes rather than inventing retry-safe failures. |

The DSH source baseline uses ESM, Node `^22.19.0 || >=24.0.0`, pnpm and TypeScript. Use a compatible Node/ESM toolchain for the experiment, and pin actual dependency versions at implementation time. Repository-local package directory names below are proposed; they are not reserved or published npm names.

## Module layout and intended split

| Directory | Responsibility |
| --- | --- |
| `packages/client` | Typed revision-1 messages, framing, multiplexing, request journal, resource handles, stream offsets/acknowledgements and transport-loss errors. Independent of DSH and SSH provisioning. |
| `packages/ssh` | System OpenSSH entry resolver, artifact manifest/verification/install, runtime startup, heartbeat/reconnect, lifecycle and effective remote environment. |
| `packages/dsh-ssh` | Cordis runtime owner, immutable World binding and creation/resume composition, Agent-visible context and approval metadata. |
| `packages/fs-ssh` | DSH filesystem adapter, World-scoped target keys, strict text decoding and edit rules, guarded remote publication, FS error mapping. |
| `packages/subprocess-ssh` | DSH provisional pipe/PTY handles, local collection mirrors, exact managed-executable mapping, owner reference sets and disposal. |
| `tests/integration` | Real external composition fixtures, local/remote sentinels, lifecycle/failure injection and package-loading tests. |

Cargo/Rust sources retain their existing layout. The TypeScript workspace now contains private client and SSH packages; the experimental FS/subprocess providers currently live in `packages/dsh-ssh/src`. Split and package the providers only when an installable DSH dependency baseline is established; do not create empty placeholder packages or publish packages during preparation.

## Compatibility issues to resolve first

| Issue found in the current helper / DSH comparison | Required treatment |
| --- | --- |
| DSH search defaults to `RAW_OUTPUT_MAX_BYTES = 20_000_000`; the original helper collection limit was 1 MiB. | Resolved for the current experiment: helper 0.1.1 supports 32 MiB/collect stream with a shared 64 MiB runtime reservation and 32 KiB frame payloads. The actual DSH search consumer passed with its unchanged default. Spill remains 16 MiB and larger requests fail explicitly. |
| DSH accepts grace values up to its maximum Node timer; helper accepts at most 30 seconds. | Validate against advertised support before spawn and return an explicit unsupported-limit error, or extend and test the helper contract. Do not silently shorten grace. |
| Helper directory listings stop with a resource error beyond 1000 entries; uploads are capped at 64 MiB. | Document the initial supported profile. Add bounded pagination/streaming or explicit provisioning limits before claiming unrestricted filesystem-seam compatibility. Never return a successful partial listing. |
| Stream events can overlap RPC snapshots/reconnect replay; `process.state.closed` can arrive before the final stream frames are installed locally. | Merge by original byte offsets, deduplicate overlap, expose collect gaps, and settle `done` only after installing the final required output state. For raw streams, loss is an error, never a resumable silent omission. |
| IDs and offsets are JSON numbers. IDs are limited to 2^53-1; offsets can grow beyond JavaScript's exact range. | Parse losslessly or fail explicitly at an agreed supported boundary. Do not silently round byte positions or change the wire format without revising/documenting it. |
| Resume requires the token returned by the original hello. A first hello response can itself be lost. | Do not assume the client can recover a token it never received. Treat that startup as unbound, let the orphan runtime expire, and start a new runtime before any workload was submitted. Runtime discovery/token recovery is a separate optional protocol change. |
| Current helper protocol has a 32-request ordinary admission ceiling and bounded response retention. | Reserve local capacity for heartbeat/cancel/ack/termination, bound the pending journal, and distinguish not-admitted requests from admitted-but-unknown outcomes. `REQUEST_EXPIRED` is not permission to repeat an operation with a new ID. |
| DSH `done` consumers expect actual exit facts, whereas loss of a runtime can leave exit unobserved. | Keep handles pending during bounded reconnect; verify the consumer-visible infrastructure-failure path after permanent loss. Never synthesize an exit code or claim confirmed cleanup on transport loss. |
| The current x86_64 helper was accepted in a glibc 2.39 environment; the ARM64 helper is static musl. | Do not label the x86_64 artifact universally Linux-compatible. Choose and test a portable musl artifact or measure/document the dynamic glibc floor in the release manifest. |

These findings do not invalidate the recorded helper behavior tests. They distinguish helper API acceptance from full consumer compatibility and identify the work needed before an external DSH release.

## Work sequence and completion conditions

### 1. Protocol client and ownership

- [x] Implement a typed, transport-independent framed client. Reject malformed frames/envelopes; keep byte payloads binary-safe.
- [x] Match the Rust hello/capability/limit report and fail before workspace operations when required support is absent.
- [x] Allocate monotonic IDs and retain bounded exact request content until outcome/recovery is resolved. Retransmit only the same ID/content to the same runtime.
- [x] Implement raw delivery with acknowledgement tied to actual bounded downstream consumption. Receiving a transport frame alone is not proof of consumption.
- [x] Implement collected-output mirrors/snapshots with exact offsets, gap reporting and finalization. Resolve the search-budget mismatch before enabling the default search configuration.
- [x] Serialize stdin/EOF locally, split input into accepted chunks, and preserve partial-write errors. Track all provisional allocations until publication or confirmed cleanup.
- [x] Use explicit states: starting, ready, reconnecting, closing, closed, failed. Suspend admission during reconnect; a failed World never selects a local provider.

Completion: client tests use the real helper and deterministic connection interruption around spawn, file commit, partial stdin, stream acknowledgement and final output. The same-session request is executed once; an expired/new runtime never re-executes it automatically.

### 2. Minimal external composition experiment

The checked-in fixture proves provider scoping, guarded edits, synchronous handles/readers, the unchanged 20 MB search budget, completed process-slot reuse, two provider owners sharing one World and a second World. It loads an explicit client through Cordis Loader builtins. The subsequent [Agent fixture](agents.md) adds real Agent Loop/Session behavior, child inheritance, full-history cold resume and publication rollback. Independently packaged plugin compatibility is still unproven.

- [x] Load the shared runtime plus minimal filesystem/subprocess adapters and actual DSH consumers through the E2B-style external loader composition, using explicitly supplied artifacts.
- [x] Use unpublished Agent setup and a shared isolated realm for providers and relevant consumers. Validate remote cwd before first prompt/tool execution.
- [x] Run actual DSH file/search/argv tools with local/remote sentinels, reject local-tool bypass, and verify World loss before Agent publication.
- [ ] Extend the actual Agent fixture with missing-artifact and mid-tool transport-loss cases; the existing provider/client suites already cover these mechanics.
- [ ] Resolve and map DSH's exact packaged-ripgrep path in both Node/package and bundled-sidecar cases as applicable. Keep argv and `--no-config` unchanged; unrelated executable paths must not be rewritten.
- [x] Exercise two owners sharing one World, owner disposal, child creation, and a second World. One owner's disposal must not terminate the other owner's process; cross-World work uses a new Agent/handoff.
- [x] Add World identity, remote cwd, platform/capabilities and connection state to the Agent context before publication. Provide the same World context to the assumed Auto Approval boundary.
- [ ] Compare adapter FS edit fixtures with the pinned DSH rules, and test synchronous `spawn`/`readFrom`, PTY lifetime, post-exit reads and job teardown.

Completion: a checked-in fixture demonstrates real consumer routing and setup rollback without DSH core edits. If a consumer bypasses the World seam, provide an external adaptation or explicitly exclude it from this composition. Do not call an untested plugin compatible merely because the principal tools passed.

### 3. SSH resolver, bootstrap and installation — implemented for trusted local artifacts

- [x] Use system `ssh` with argv and the user-selected SSH host/config. Preserve keys, ssh-agent, ProxyJump and host verification. No embedded SSH library, implicit host-key acceptance, or arbitrary `shell:true` command construction.
- [x] Keep remote control-command quoting separate from Agent process argv. SSH control scripts detect the target, upload artifacts and start/connect the helper; Agent commands go through `process.spawn` after readiness.
- [x] Require explicit remote cwd and validate/canonicalize it. Never derive a remote workspace from local `process.cwd()`.
- [x] Define a manifest containing helper build/API, OS/architecture/ABI, byte size/SHA-256 and ripgrep version/digest. Obtain caller-supplied artifacts in a local cache; a target needs neither public internet nor a compiler.
- [x] Install to configurable account-writable storage without sudo, with private staging, bounded publication locking, immutable generations and atomic reference publication.
- [x] Upload over SSH stdio so targets without SFTP remain supported. Verify actual remote bytes and executable versions before use.
- [x] Keep runtime sockets in fresh private directories within platform path limits; `start` receives an absent runtime directory.
- [x] Connect, negotiate, validate required capabilities and managed ripgrep, then expose readiness. Resume credentials remain in local owner memory.
- [x] Heartbeat within the inbound lease and reconnect within finite grace to the same runtime. A later explicit bootstrap call creates a fresh runtime.
- [x] Install upgrades alongside active binaries. Existing owners retain their exact helper path/runtime and tasks.

Accepted scope: cold install, reuse without local cache, corruption repair, interrupted upload, lost publication response, concurrent install, bounded lock contention, unusable default directory with explicit alternative, incompatible API/build/capability, reconnect and real-version upgrade. Platform records use categories only. See [bootstrap limitations](bootstrap.md) for forced-SIGKILL stale locks, unreferenced staging, retained generations and unverified crash durability; automatic garbage collection and release download trust are separate work.

### 4. Release preparation

- [ ] Re-run helper and client/composition suites against supported Linux ABI targets and explicit native macOS tests where applicable. A native client test does not substitute for Linux helper execution.
- [ ] Produce platform manifests and reproducible build/checksum records, with the separate licenses/notices needed for redistributed ripgrep.
- [ ] Verify independently installed external packages load against the pinned DSH release, not only against source-workspace aliases.
- [ ] Document supported consumers and operational limits, failure/unknown-outcome behavior, account-level permissions and the no-local-fallback contract.

Completion: published-package compatibility is proven before claiming a production SSH World. Publishing npm packages, public releases, Container resolvers, durable tasks and Remote Harness remain separate work; this preparation does not perform those actions.

## Next implementation slice

Completed: client, bootstrap, providers, Agent creation/resume binding, one-shot child inheritance, explicit handoff and the verified read/write/edit/glob/grep/exec profile. The external local Session backend keeps World ownership records required and checkpoints full live history. See [Agent behavior and limits](agents.md).

Next implement the PTY adapter using the existing helper API, with resize, stdin, streaming, termination and final-output semantics matched to DSH. Then compose the actual terminal and Session-job consumers in the World. Bind every job to its Agent owner, verify close during reconnect and after root exit, and keep nonpersistent runtime ownership explicit. Bash-dependent consumers must be gated by target capabilities.

Before exposing a full application preset, resolve per-child tool restrictions and continuation composition, review every workspace consumer for direct Node filesystem/process use, and verify independently installed packages. The source experiment now also requires `WorldToolRuntime` and `WorldSessionPersistence`; ordinary JSONL persistence cannot read its required extension records. Evaluate storage migration, asynchronous write performance, capacity policy and package compatibility explicitly. Release catalogs/download provenance and installation garbage collection remain distinct distribution/lifecycle work.
