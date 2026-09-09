# Helper API revision 1

Wire revision 1, helper 0.1.3. This contract defines runtime-owned processes, bounded live-runtime reconnection, filesystem operations, cleanup facts, and output/backpressure. DSH integration status is maintained in the root README.

## Design basis

| Reference | Applied idea |
| --- | --- |
| [DSH E2B and provider seams](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/e2b) | A shared runtime supports filesystem and subprocess providers. DSH model calls, Session state, tool policy, editing rules, and presentation stay local. |
| [Distant API](https://github.com/chipsenkbeil/distant/blob/master/distant-core/src/api.rs) | Small OS operations, process references, binary input/output, PTYs, and lifecycle control. Allocation responses precede associated events. |
| [VS Code ExecServer](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.resolvers.d.ts) | Explicit argv, environment, cwd, streams and exit observations; future resolvers start the same helper in the final environment. |
| [Zed remote development](https://zed.dev/docs/remote-development) | System SSH and independently deployed target-native binaries. |

These are design references, not wire compatibility claims. DSH was inspected at the pinned commit; reference inspection was on 2026-09-05. Agent Host is only a future Remote Harness reference.

## Runtime and transport

`dsh-remote start --runtime-dir ABSENT_ABSOLUTE_DIR --cwd ABSOLUTE_DIR` starts `serve` in a separate session with detached stdio. `serve` creates a fresh mode-0700 directory and a mode-0600 Unix socket named `socket`. `connect --socket PATH` bridges stdin/stdout to that socket and can be launched through system OpenSSH. It exits when either side closes; it never executes a local substitute. A native macOS instance is an explicit acceptance target.

The runtime owns its processes, open read streams, uploads, collection buffers, and spill files. It has one logical session and at most one active controller. Connecting to an occupied session returns `SESSION_BUSY`. Different Worlds use separate runtimes; sharing OpenSSH transport does not merge ownership. Local providers own their process references; DSH consumers may additionally track Agent owners. A provider's disposal terminates/releases its own set; global shutdown closes the runtime.

The default inbound lease and disconnected grace are each 30 seconds. `--lease-ms` and `--grace-ms` accept 100..300000 milliseconds. A complete inbound frame renews the lease; output does not. EOF, malformed framing, a two-second stalled outbound write, or lease expiry disconnects the controller. During grace, existing operations and processes continue with the same resource IDs and bounded output storage. Reconnection requires the runtime ID and secret token issued by the first hello. Wrong credentials, a different World, an expired runtime, or attempting to resume into a fresh runtime fails explicitly.

Grace expiry or helper TERM/INT triggers managed cleanup. Explicit `runtime.shutdown` stops admission immediately and reports cleanup completion or a deadline error. There is no task journal, cross-helper-restart recovery, task adoption, or automatic re-execution in a new session. Agent-created external persistence is outside helper supervision. OS logout/session policies may kill the runtime itself; a detached session is not immunity from host policy, helper SIGKILL, or reboot.

The socket/token is scoped to the same account, not a security boundary against that account. The helper has the invoking account's filesystem/process permissions. Cwd is not a sandbox. The helper supplies operation facts, not approval policy; see the [execution boundary](../execution-boundaries.md).

## Framing and requests

Each frame is a four-byte **big-endian** unsigned payload length followed by UTF-8 JSON. Payload length must be 1..2097152 bytes. No compression or implicit shell interpretation is used. Binary `data` fields are standard padded Base64. IDs and offsets are byte coordinates, never UTF-16 string positions. Request IDs are integers in 1..2^53-1; clients must preserve large byte offsets exactly when decoding JSON.

First frame:

```json
{"id":0,"method":"runtime.hello","params":{"api":1,"world":"example","required":["process.pty","runtime.resume"]}}
```

For resume, add `runtime` and `token` from the original hello result. Do not put these credentials into logs or committed configuration. Hello returns API/build version, runtime/token, World, canonical cwd, OS/architecture, effective capabilities/limits, grace/lease, cleanup scope, and `requestHighWater`. Missing required capabilities or incompatible revisions fail before admitting work. PTY availability is probed, not inferred from the OS name. Actual allocation or filesystem calls can still fail after hello.

Subsequent frames:

```json
{"id":1,"method":"runtime.ping","params":{"value":"ready"}}
{"id":1,"result":{"runtime":"opaque-runtime-id","value":"ready"}}
{"id":2,"error":{"code":"NOT_FOUND","message":"executable unavailable in target environment","details":null}}
```

Only requests have `method`; events have `event` and `value`, without a request ID. Unknown methods return `UNSUPPORTED`. Frame/envelope corruption disconnects the transport. Helper diagnostics use stderr; child stderr is identified process output.

New request IDs increase in admission order. Concurrent requests may complete out of order. Within this live session, retransmitting an admitted ID with the same normalized JSON content returns its cached response or attaches to the in-flight outcome; it does not execute the operation again. Different content returns `REQUEST_CONFLICT`. The cache retains at most 256 completed responses / 8 MiB. An older evicted ID returns `REQUEST_EXPIRED`, never executes again, and leaves an uncertain old outcome uncertain. A fresh runtime rejects old resource IDs. Admission-limit errors mean the request was not admitted; they do not advance the high-water mark. There is no durable exactly-once guarantee.

Response loss is not proof of cancellation. Re-send the *same* request ID only while resuming the same runtime, with identical content. Never turn an uncertain spawn, input write, signal, or publication into a fresh-ID retry. In particular, a partially written stdin result reports its known prefix and is not automatically replayed as a new write.

## Operation inventory

The approved logical operations are encoded as 27 wire methods: guarded byte publication is split into a bounded upload transaction; stream reading/acknowledgement/release are explicit transport controls. They are not additional Agent-facing tools.

### Runtime

| Method | Parameters | Result |
| --- | --- | --- |
| `runtime.hello` | `api:1`, initial `world`, optional `required`; resume adds `runtime`, `token`. ID must be 0 and this must be the first frame. | Negotiated identity, platform, capabilities, limits and high-water mark. |
| `runtime.ping` | Optional `value`. | Echo and runtime identity. |
| `runtime.cancel` | `request`: admitted request ID. | `status: accepted / settled / unknown`. Accepted is a cancellation request, not a rollback or cleanup guarantee. |
| `runtime.shutdown` | Optional `deadlineMs` (default 5000, max 35000). | `cleanupComplete:true` with scope, or `CLEANUP_INCOMPLETE`. Stops new admission. |

### Filesystem

Paths are native UTF-8, NUL-free absolute paths except `fs.resolve.path`, which may be relative to the supplied/default cwd. No `~`, environment-variable or shell expansion occurs. Non-UTF-8 directory names fail explicitly.

| Method | Parameters | Result |
| --- | --- | --- |
| `fs.resolve` | `path`, optional absolute `cwd`. | Canonical `path`; follows existing and dangling symlink targets, preserving the missing suffix. |
| `fs.stat` | `path`, optional `follow` (default true). | Metadata or null for absence. Metadata has `kind`, `size`, permission `mode`, opaque `version`; no-follow identifies symlinks. |
| `fs.list` | `path`, optional `maxEntries` (default/max 1000). | Complete direct `entries` sorted by name, each with `name`, canonical `path`, metadata. Excess entries cause `RESOURCE_LIMIT`; there is no successful truncated listing. |
| `fs.read` | `path`, required inclusive whole-file `maxBytes`. | An opened-file byte `stream` and initial metadata/version. Only regular files; size and growth are checked. |
| `fs.readRange` | `path`, byte `offset` (default 0), `length` (default 0, at most 64 MiB). Requires `fs.read-range` capability (helper 0.1.3+). | Regular-file stream and initial metadata; reads only the requested window, may return fewer bytes at EOF. No whole-file size limit or local fallback. |
| `fs.beginWrite` | `path`, optional `expected`, `maxBytes` (default 16 MiB, max 64 MiB). | Runtime-scoped `upload`. Creates missing parents and private staging on the destination filesystem. |
| `fs.writeChunk` | `upload`, `offset`, Base64 `data` (max 32 KiB decoded). | Accepted `next` offset. Requires exactly the accepted byte count; partial I/O failure invalidates staging. |
| `fs.commitWrite` | `upload`. | `committed:true`, `kind:create/update`, published inode metadata (null if post-commit metadata observation fails). |
| `fs.abortWrite` | `upload`. | Closes/removes uncommitted staging. Committed/unknown upload is not undoable. |
| `fs.sync` | Absolute `path`; requires `fs.sync` capability. | `synced:true` after syncing the existing regular file and its ancestor directories. Rejects a symlink final component and non-regular files. Failure does not undo prior publication. |

`expected` is `{"kind":"any"}`, `{"kind":"absent"}`, or `{"kind":"version","version":"opaque-token"}`. Version is SHA-256 of stat identity/freshness fields, **not** a hash of content. Reads bind to an open file but are not snapshots against unrelated writers modifying that inode. Clients must wait for successful stream EOF before returning a complete file.

Publication serializes commits within this helper, validates the version at staging and immediately before publication, then uses rename for replacement or a hard link for atomic create-if-absent. Missing support for hard-link publication fails explicitly. Replacing a symlink path updates its resolved target. Changed path resolution fails at commit. Regular rwx bits are preserved; new files use 0600. ACLs, xattrs, set-ID bits and shared hard-link inode identity are not preserved. Cancellation before publication leaves target content unchanged; newly created parent directories may remain. After publication, the result remains committed even if staging cleanup or metadata observation fails. Atomic visibility is provided; parent-directory crash durability and filesystem-wide CAS against unrelated writers are not promised.

Text decoding, NUL rejection for DSH text APIs, CRLF/LF handling, literal match selection, replacement, and diff calculation belong to the **local filesystem adapter**. Its edit sequence is remote read + version → local matching/newline/diff work → remote staged bytes + expected version → commit. A stale observation causes re-read/review, not a silent overwrite. Synchronous target-path helpers (`processPath`, `fileUrl`, `contains`) also remain in the adapter; ordinary local paths have no remote mapping.

### Process and PTY

| Method | Parameters | Result |
| --- | --- | --- |
| `process.resolveExecutable` | `command`, absolute `cwd`, optional `env`. | Canonical executable `path` from the remote environment. Bare PATH names or absolute paths only. |
| `process.spawn` | Spawn specification below. | `process`, diagnostic OS `pid`, `outputs` with stream IDs/modes. Response precedes its events. |
| `process.write` | `process`, Base64 `data` (max 32 KiB). | `written` bytes; errors can carry a written prefix. |
| `process.closeStdin` | `process`. | Ordered, idempotent pipe EOF. PTY half-close is rejected. |
| `process.readOutput` | `stream`, optional `offset` (default 0). | Non-consuming snapshot; alias of `stream.read`. |
| `process.status` | `process`. | Root exit, output closure, scoped cleanup and termination progress. |
| `process.signal` | `process`, `signal`, optional `target:initial-group/foreground`. | `signalSent`, addressed group and number of observed members signalled. |
| `process.terminate` | `process`. | Idempotent `accepted:true`, current cleanup fact; starts remote TERM→grace→KILL. |
| `process.release` | `process`. | Release after output is closed and scoped cleanup complete. Otherwise `RESOURCE_BUSY`. Exported spill files remain until runtime cleanup. |
| `pty.resize` | `process`, positive `rows`, `cols` up to 65535. | Applied terminal size. |
| `pty.foreground` | `process`. | Current foreground `group`, `inputWaiting:"unknown"`. No waiting claim is inferred from silence. |

Spawn requires nonempty NUL-free `argv` and an absolute directory `cwd`. `argv[0]` is resolved remotely. Shell features require an explicit shell argv; exec failures are allocation errors, while an actually started shell returning 127 is a normal exit. `env` overlays the remote helper's ambient environment, after scrubbing keys matching KEY/PASSWORD/SECRET/TOKEN (case insensitive) or the `DSH_` prefix. String overrides deliberately restore values, including credentials; null deletes a value. Local model-client environment is never the base.

`mode` is `pipe` (default) or `pty`. Pipe stdin is `ignore` (default), `pipe`, or `{"data":"base64"}` followed by EOF. `stdout`/`stderr` independently use `{"mode":"raw","maxBytes":65536}` or `{"mode":"collect","maxBytes":65536,"spillBytes":1048576}`. Limits must be positive. Raw output is capped at 1 MiB/stream; collection at 32 MiB/stream, with a 64 MiB runtime reservation shared by process and file-read buffers. Spill remains capped at 16 MiB/stream. Reservations follow actual buffer lifetime and are refunded after release/reader shutdown or failed allocation. DSH `inherit` forwards raw remote output into a local parent stream; the child never inherits protocol stdout.

PTY mode allocates a real controlling terminal, merges output, uses positive `rows`/`cols` (defaults 24/80), and uses raw output with `maxBytes` (default 64 KiB). Environment such as `TERM` is explicit. Byte input gets no implicit newline/EOT translation. `graceMs` (default 1000) and `drainMs` (default 2000) must be 1..30000. Signal names are INT, TERM, KILL, HUP, QUIT, TSTP, CONT, USR1, USR2; signal numbers are platform constants.

Input writes and EOF for a process, and chunks/commit/abort for an upload, execute in request-admission order. Other operations can run concurrently. Cancel a blocked input write with `runtime.cancel`; cancel a published process with `process.terminate`. The DSH adapter binds ordinary spawn cancellation for the handle's lifetime, while terminal allocation cancellation ends at publication. A cancelled provisional allocation stays tracked until managed cleanup; no child is deliberately forgotten.

## Output, replay and backpressure

| Method | Parameters | Result |
| --- | --- | --- |
| `stream.read` | `stream`, optional `offset`. | At most 32 KiB, without consuming server data. |
| `stream.ack` | Raw `stream`, consumed `offset`. | `acknowledged`; frees bytes before this point. Older acknowledgements are harmless; acknowledgement beyond production is invalid. |
| `stream.close` | File-read `stream`. | Cancels the reader and releases its buffer. Process streams are released with the process. |

`stream.data` events and read snapshots share fields: `stream`, `mode`, `offset`, `next`, `produced`, `retainedFrom`, `gap`, Base64 `data`, `eof`, `error`, `spill`, `revision`. `offset` is the actual start of returned data; `next` is its end; `produced` is the total admitted to that output buffer. EOF may accompany a partial final delivery, so drain through `produced` before settling. Output ends successfully only when `error` is null. Forced drain returns `OUTPUT_INCOMPLETE`; bytes still in OS pipes or an interrupted read are not fabricated as delivered data.

Raw buffers retain unacknowledged bytes up to their cap. Reading or receiving an event does not acknowledge them. At capacity the helper stops draining the OS endpoint, applying real backpressure to the child/file reader. Control traffic has separate admission capacity. On reconnect, events replay from the retained acknowledgement position with original offsets. Clients discard duplicated bytes they already hold and acknowledge only what they have consumed. Explicitly reading before the retained position reports a gap; a raw consumer must not pretend the missing prefix is available.

Collect mode drains into a bounded byte tail. Events and RPC snapshots both carry at most 32 KiB of decoded bytes, including a final large retained tail; producers need not append again for delivery to continue. Slow consumers get coalesced updates and explicit gaps; no raw-protocol semantics are claimed. Tail boundaries may split UTF-8. Offsets beyond `produced` are invalid. Optional spills retain the full byte sequence through the advertised produced offset. Exceeding the spill cap removes the partial file and stops advertising a full copy; disk errors are explicit. A runtime accounts for at most 64 MiB of spill capacity: active processes reserve their configured caps; process release returns unused capacity but keeps completed spill files charged at their produced byte length until runtime cleanup. Retained output can still exhaust this budget.

Buffers survive a transport disconnect only within the live runtime/grace window and under the same caps. No extra unlimited reconnect buffer exists. The DSH adapter maintains a bounded local collection mirror for synchronous `readFrom`, and installs final output state before settling `done`; it cannot implement synchronous `readFrom` with an RPC. It tracks root exit and stream EOF independently because process-state and stream events have no cross-resource total ordering.

## Cleanup facts and limits

`process.state` events contain `rootExit` (code/signal/signalName/core dump), `closed`, `cleanupComplete`, `cleanupScope:"observed-session-members"`, `observationError`, `terminationAccepted`, `termSent`, `killSent`, and a revision. Capability `process.exit-signal-name` means the target reports the portable `SIG*` spelling alongside its numeric signal; unrecognized signals have a null name. A client must not interpret a target signal using its own OS's numeric table. These express separate facts:

1. Cancellation or termination was accepted.
2. A signal was actually sent to observed live members.
3. The original child exited.
4. Output closed successfully or with an explicit drain failure.
5. No live member remains in the helper's observable, managed session scope.

All children start in their own session, including pipe-mode children. Linux uses `/proc` plus subreaping of adopted known descendants; macOS uses native process/PTY APIs. PID birth metadata scopes observations and is rechecked before sending a signal. Session membership is refreshed while a known anchor remains; a completed resource is never reactivated. This is best-effort Unix process observation, not a race-free kernel process-containment primitive. Observation failure remains unknown/incomplete. TERM is accompanied by CONT for stopped members; escalation continues while disconnected.

Root exit does not prove cleanup. Descendants retaining output descriptors are subject to the drain deadline; they remain tracked after output closure. Deliberate `setsid` escapes, external service delegation, inaccessible descendants, helper crash/restart, and uninterruptible kernel activity are outside a guarantee to reclaim arbitrary descendants. No cgroups, root, systemd, user lingering, or GNU ps are required.

Hard runtime ceilings are 16 retained processes, 64 streams, 16 uploads, 32 ordinary in-flight requests plus 8 control slots, 256/8 MiB cached responses, and 2 MiB/frame. Streams, input chunks and upload reservations have the limits above. An active raw stream additionally has one bounded read chunk and OS buffering outside the retained ring. Released event cursors are removed. Filesystem I/O runs outside async executor workers; a syscall already inside the kernel cannot always be cancelled, and a cleanup deadline must not be treated as proof that such work ended.

Stable errors distinguish invalid input, unknown/expired session/resource, unavailable capability/version, missing/not-directory/not-regular files, permission failure, stale version/create conflict, size/resource limits, cancelled/closed work, OS I/O, and incomplete cleanup. Transport failure is observed locally and does not create a remote exit code or an automatic retry.

## DSH integration boundary

DSH adapters own provisional handles, local collection mirrors, text editing and Agent context. Search runs target-native ripgrep through `process.spawn`; the adapter maps only DSH's exact registered packaged-ripgrep identity. The helper has no search engine or basename-based executable rewrite. Current composition is described in [architecture](../architecture.md); historical platform evidence remains in [helper acceptance](../../.agents/notes/archived/2026-09-initial-integration/helper-acceptance.md).
