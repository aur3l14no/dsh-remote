# SSH Execution World: constraints and staged delivery

Status: approved design baseline, 2026-09-05. The [helper API and wire contract](helper-api.md) are implemented. See [platform acceptance](helper-acceptance.md) for measured results; external DSH composition remains a later milestone.

## Confirmed requirements

The implementation must ship entirely outside DSH core. The model client, Agent loop, Sessions, Session persistence, UI, and plugin objects remain local. Every operation on workspace files, search, processes, Shell/PTY, signals, cancellation, and task output goes through the selected World and executes in its final remote environment. A failed connection or unsupported capability never selects a local execution provider.

The first resolver enters an SSH Linux host using system OpenSSH. SSH config, keys, ssh-agent, ProxyJump, authentication prompts, and host verification remain OpenSSH responsibilities. Later resolvers may compose additional environment-entry steps; the same helper runs in the final environment.

A World records its target environment, workspace, and execution configuration. Its identity outlives an individual SSH connection. Compatible transports and helper instances can be pooled without conflating workspaces or task ownership. Agents bind before publication; child Agents inherit by default. Cross-World work uses a new Agent or explicit handoff. Exact identity serialization remains a design decision.

Remote execution has the SSH account's permissions. The workspace directory is not containment. A separate Auto Approval plugin is assumed to exist. Approval inputs must identify the World, remote account, cwd, and concrete operation; approval for one World must not silently authorize another. Provider routing is a compatibility contract for trusted plugins, not a sandbox around arbitrary in-process plugin code.

V1 provides managed subprocess capabilities, including background execution during the live runtime. It does not implement task persistence, detached supervision, cross-restart task adoption, or replay across helper restarts. Within the same live runtime, bounded output replay is available during the reconnect grace period. The Agent may arrange persistence with remote programs, services, logs, and checkpoints through ordinary subprocess calls. Their durability is owned by those programs and the Agent's workflow, not guaranteed by the helper.

Search runs a compatible Linux ripgrep binary uploaded through SSH alongside the helper. Reuse DSH's search tools where possible by binding their known packaged executable to the deployed remote executable. The helper supplies the subprocess capability used to execute it.

## DSH source baseline

Initial inspection uses the official repository at commit [`d347e703908d0406b7a7ef80e3a0e594d86b2215`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215). This is a research baseline, not yet a tested minimum supported release. Recheck against the selected published DSH version before releasing adapters.

| Area | Observed contract | Consequence for this project |
| --- | --- | --- |
| E2B composition | `ctx.e2b` owns one sandbox; `ctx.fs` and `ctx.subprocess` share it. | Keep one SSH runtime owner and two OS providers. The helper must not create a private environment for each provider. |
| Filesystem | Opaque targets and versions; resolve/stat/lstat/read/stream/list; guarded writes and literal edits; explicit conversion to process paths and file URLs. | A basic read/write RPC is insufficient for the complete adapter. Preserve stale-write detection, remote path semantics, cancellation, and typed errors. |
| Subprocess | Synchronous spawn handle, asynchronous outcome, explicit stdio and environment, offset-based collected reads, tree termination, and a separate terminal primitive. | Plan asynchronous startup and byte-oriented streams in the helper. Keep shell policy and model-facing result formatting above the OS provider. |
| Search | The current consumer resolves a host-packaged ripgrep path, then passes that absolute path to `ctx.subprocess.spawn`. | Upload target-platform ripgrep and explicitly map the known packaged executable to its remote installation in the external adapter. Verify the existing tool's argv, output parsing, and errors end to end; do not rewrite arbitrary executable paths. |
| Agent creation | Both create and resume accept awaited `setup` before publication, with rollback on setup failure. | This is a candidate binding point. It does not by itself prove all existing consumers resolve the intended per-Agent providers. |
| Service composition | Loader groups can share an isolated service realm across a provider and its consumers. | Prototype the complete consumer group in the same realm. Merely adding providers to an Agent context may leave existing consumers bound elsewhere. |
| Process disposal | Subprocess service disposal terminates managed processes and awaits exit. | Honor the existing contract. On transport loss, suspend access to affected handles and allow bounded live-runtime resumption. On explicit disposal or grace expiry, clean up remotely; do not claim unobserved termination succeeded. |
| Background jobs | `ctx.jobs` tracks ownership by Session; owner/service disposal cancels live work. Producers retain execution resources. | Keep the existing DSH job lifecycle over remote subprocesses. No durable remote job registry or ownership-transfer mechanism is required in V1. |

Sources: [E2B owner](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/e2b/e2b/src/index.ts), [filesystem contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/fs/fs/src/index.ts), [filesystem types](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/fs/fs/src/types.ts), [subprocess contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subprocess/subprocess/src/index.ts), [subprocess types](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subprocess/subprocess/src/types.ts), [search consumer](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/fs/tool-fs-search/src/search-core.ts), [Agent factory](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/src/index.ts), [Loader group support](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/boot/app-boot/src/index.ts), [jobs contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/jobs/jobs/src/index.ts).

These findings support an external-plugin approach, but they are not a composition test. The initial integration experiment must prove scoped provider selection, pre-publication failure, Agent-visible context, World rebinding when a local Session resumes, and absence of local fallback. Resuming DSH Session history does not reconstruct handles after helper restart. Transport reconnection to the same live runtime may retain them.

## Proposed ownership and transport

Use a local runtime owner to bootstrap OpenSSH and expose a shared remote handle. V1 uses a user-level Rust runtime with a private Unix socket; an SSH-launched stdio bridge connects to it. Processes belong to the runtime, independently of the bridge. Connection loss starts a finite grace period; matching session credentials reconnect to the same resources. This is an in-memory runtime, without per-task durable supervisors or recovery across helper restarts. See the implemented CLI and framing in [helper-api.md](helper-api.md).

The helper owns live process identities, process/session handles, input, bounded collected output, and termination timers. The local plugin owns the World-to-Agent/Session binding and maps remote observations into DSH handles. Multiple collected-output readers use independent offsets within the live runtime. Each managed process has an explicit owner; sharing a connection must not allow one owner to control or clean up another owner's processes.

Use World IDs, helper instance epochs, live process IDs, and request IDs for distinct purposes. Process IDs in the protocol are scoped to one helper instance; neither those IDs nor output offsets survive replacement of that instance. A PID is an observation, not an authorization token. Version negotiation reports protocol compatibility and actual available capabilities, including the installed search executable. Missing required capabilities stop startup; unsupported optional operations return explicit errors.

The helper's private runtime directory is accessible only to the remote account; no public network listener is required. File and process permissions remain those of that account. Do not upload local credentials or the local workspace implicitly. The system SSH client may apply the user's own configured forwarding behavior.

Installation uses locally obtained, integrity-verified helper and ripgrep artifacts uploaded through SSH, requires no remote compiler or public internet, and uses configurable writable user storage. A read-only HOME must either be handled by an explicit alternative directory or produce an installation error. Versioned artifacts let an active connection continue using its existing helper while a new connection selects a compatible version. Do not migrate process handles or restart active processes to upgrade a binary.

Protocol encoding, bounded output budgets, and connection-failure detection are defined in the helper contract. External plugin package names, production binary distribution, and installation locking remain later-stage decisions. x86_64/arm64 and libc compatibility for both helper and ripgrep must be made explicit in the first release's tested platform matrix.

## Remote ripgrep deployment

The runtime owner obtains a ripgrep build for the remote Linux architecture and libc, pins a compatible version, verifies its integrity, and uploads it into a managed versioned directory. A local macOS or Windows executable must not be copied as the Linux executable. The owner validates the installed remote binary before enabling search and exposes its absolute remote path to the subprocess adapter.

The proposed adapter registers an explicit World-scoped mapping from the exact packaged ripgrep executable identity used by the selected DSH carrier to the uploaded remote executable. Before remote spawn, only that known identity is translated; all arguments, remote cwd, stdio dispositions, output limits, and cancellation semantics are preserved. Resolve the mapping during setup and verify it with the actual DSH consumer. Never apply a basename-only `rg` rewrite or a general translation of arbitrary local absolute paths.

This mapping is managed executable deployment, not workspace synchronization or a claim that the host and remote binary are the same file. Do not expose it as a general host-file mapping through the filesystem provider. Missing, incompatible, or unbound ripgrep fails search explicitly; it never executes a local search or silently selects another binary. The existing search consumer and parser remain the preferred path; the exact external adapter hook still needs a composition test.

## Lifecycle without persistence

| Event | V1 behavior |
| --- | --- |
| Managed process runs in the background | The helper continues supervising it and exposes status, output, and cancellation during the live runtime. Background execution does not imply persistence. |
| Agent/Session is disposed or DSH exits normally | Follow DSH's owner/service cleanup contracts and await managed-process teardown. |
| Transport is lost | Report transport failure and unknown remote outcomes where appropriate. The helper retains runtime resources for a finite reconnect grace period, then begins cleanup if no controller returns. Detection, grace and cleanup have explicit time bounds; the client must not report cleanup as confirmed without evidence. |
| Connection is re-established | Within grace, authenticate to the same runtime and retain its process/stream identities; identical same-session request IDs are deduplicated. Otherwise create an explicitly new runtime and reject old handles; never re-execute old commands automatically. |
| Helper crashes, DSH restarts, or the host reboots | Do not reconstruct old managed-process state or promise process survival. Local Session history may resume independently of live execution resources. |
| An artifact is upgraded | Install a new version for subsequent connections; let the active connection keep its existing executable until normal teardown. No live process migration is required. |

An Agent can use ordinary remote subprocesses to arrange application-level persistence or hand work to an independently owned remote service. The helper neither implements that service nor registers it as a durable managed job. V1 does not require root, systemd, user lingering, cgroup delegation, or tmux, and does not automatically install persistence tooling.

PTY support requires usable Unix 98 PTY facilities such as `/dev/ptmx` and `/dev/pts`; report allocation failures precisely. V1 owns PTYs only for the managed runtime lifetime. See [pty(7)](https://man7.org/linux/man-pages/man7/pty.7.html).

## Failure and resource semantics

- An interrupted request can have an unknown outcome. Request correlation and duplicate detection are scoped to the live runtime session; they do not form a durable command journal or an exactly-once guarantee.
- Lost responses may be recovered only by retransmitting the same ID/content to the same runtime session. Never turn an uncertain file mutation or spawn into a new-ID execution. An unsupported or uncertain recovery result remains explicit.
- Explicit stdin close, signal delivery, termination, and process release are distinct operations. Closing the protocol connection starts the runtime reconnect grace period; expiry or explicit shutdown triggers owner cleanup; cleanup must remain separate from the client-visible transport failure.
- Once the helper accepts termination, TERM-to-KILL escalation runs remotely even if the client disconnects. Distinguish cancellation requested, cancellation accepted, root process exited, and owned process tree quiescent.
- Match DSH's process-tree and PTY-session contracts and document observability limits. Do not claim containment of arbitrary daemonized descendants based only on a process-group signal. Stronger guarantees may depend on optional cgroup facilities.
- Bound retained output and aggregate task resources. Readers receive byte offsets and explicit gaps; truncation must never look like a complete search or protocol stream. A full spill-file claim is valid only while the complete stream remains available.
- Output handling is stream-mode aware. Lossy collected output can report a gap; a raw protocol stream such as LSP cannot silently discard bytes and continue as if its protocol state were intact. There is no replay from an earlier helper instance.
- Sharing a helper does not transfer task ownership. Cleanup for one World/Agent must not terminate another owner's tasks. Cross-World handoff transfers execution context and instructions, not running subprocess handles; V1 has no managed-task ownership-transfer protocol.

## Development stages

The helper API has been confirmed with runtime-owned reconnectable resources, local text editing, scoped cleanup, and output backpressure. The [wire contract](helper-api.md) fixes revision 1. The [acceptance plan](helper-acceptance.md) covers embedded Linux/musl, containerized Linux/glibc, and native macOS using platform labels only.

1. **Helper foundation and non-PTY execution.** Define the Rust protocol model, handshake, structured errors, and runtime owner independent of its bridge. Implement filesystem primitives needed for a first read/write path, executable lookup, fully specified argv/cwd/env execution, stdin/stdout/stderr, live process status, and cancellation. Exercise search by invoking the uploaded target-platform ripgrep through the same subprocess path, without adding a separate search engine. Use a small test client; no DSH or model call is required to validate this layer. Advertise only implemented capabilities.
2. **Complete the helper's OS contract.** Add the remaining filesystem semantics, guarded byte publication supporting local text edits, streaming, collected-output/spill semantics, real PTYs, foreground-group operations, and process-tree/session teardown. Validate against the requirements extracted from the DSH seam.
3. **SSH runtime and automatic distribution.** Implement host resolver, OpenSSH invocation, helper and ripgrep upload/startup, compatibility negotiation, concurrent-install locking, and versioned upgrades. Add bounded connection-failure detection, managed owner cleanup, and bounded live-runtime reconnection. Exercise SSH config/ProxyJump and a remote host without public internet. Do not add durable task supervision, replay across helper restarts, or task adoption.
4. **External DSH composition.** Implement the shared owner, filesystem and subprocess adapters, explicit packaged-ripgrep mapping, creation/resume binding, and model-visible context. Prove the existing search tools use the remote ripgrep and the entire configured consumer group uses one World. Integrate the existing Auto Approval boundary and test remote failure with local sentinel files/processes to catch fallback. Keep existing DSH background-job cleanup semantics.

A small DSH composition experiment should run before stage 4 production implementation to resolve the identified seam risks; helper-first delivery does not mean ignoring adapter constraints until the end. Task persistence and recovery across helper restarts are outside this delivery sequence.

## First helper acceptance cases

- Reject incompatible protocol versions and unsupported required capabilities before starting work.
- Read and write a file in a Linux test workspace; the uploaded Linux ripgrep finds its content through the helper's subprocess capability. Preserve invalid-pattern and output-limit facts for the search consumer to report.
- Run argv without implicit shell interpretation; preserve explicit remote cwd and environment layering without copying the local model client's environment.
- Deliver binary-safe pipe output, including UTF-8 characters split across reads, with correct stdout/stderr separation and exit facts.
- Cancel a long-running process and its observable owned descendants; verify escalation when TERM is ignored and bounded draining when descendants hold output descriptors open.
- Reject invalid argv, inaccessible paths, permission failures, and requests against unknown tasks without substituting local operations or fabricating successful results.

Later acceptance adds real PTY job control, transport loss during process startup/cancellation/output, owner cleanup, output caps, shared-owner isolation, and rejection of handles from earlier helper instances. The DSH composition must verify the exact packaged-ripgrep mapping, a target-platform binary different from the local platform, missing/corrupt remote ripgrep, and no local fallback. Linux process/PTY behavior must be tested on Linux; a macOS compile or protocol-only test does not establish that behavior.
