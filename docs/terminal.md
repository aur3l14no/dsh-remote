# Remote PTY and Session jobs

The external subprocess adapter implements the pinned DSH terminal primitive using helper 0.1.1 / API 1. An application-owned DSH preset composes the actual terminal registry, Bash backend, terminal tools, local jobs registry and job tools. Neither DSH core nor the Rust helper changes in this milestone. See the [current platform evidence](preset-acceptance-results.json).

## Enable the consumer profile

The application places the existing terminal, Bash backend, jobs and tool plugins beside the remote providers in a standing DSH preset. The checked-in example is `tests/integration/terminal-consumers.ts`, called by the acceptance harness; it is not a runtime/tool policy shipped by the World plugin.

The fixture resolves and probes Bash remotely before preset mount completes. Missing Bash or required PTY capability fails through DSH's normal preset-mount rollback. Omitting those consumers still permits the portable PTY primitive. The same standing terminal/jobs services are shared by joined Agents; DSH's registries enforce each owner's access and cleanup. Local terminal emulation and job bookkeeping do not execute workspace processes locally.

The fixture uses SSH-account authority (`danger-full-access`) with the remote workspace. Auto Approval remains separate. It neither provides OS confinement nor makes arbitrary Node plugins safe. PowerShell, a full UI configuration and independently installed package loading are not accepted.

## Primitive semantics

| Operation or observation | Behavior |
| --- | --- |
| `spawnTerminal` | Asynchronous allocation of a real controlling PTY. Explicit argv, absolute remote cwd, environment, dimensions and cleanup grace. Exact managed executable mapping also applies here. |
| Allocation cancellation | A pre-aborted request allocates nothing. After admission, the client retains ownership while it resolves the same request journal; a late allocation is cleaned before cancellation returns. Cancellation is not permission to repeat spawn with a new ID. |
| Published handle lifetime | The allocation signal no longer owns the terminal after publication. Consumers explicitly terminate their handles; provider teardown owns final cleanup. |
| `write` | UTF-8 bytes with no implicit Enter conversion. The shared process client serializes writes, bounds pending input to 1 MiB and preserves partial/unknown write errors. |
| `done` | Target-observed root exit, using target signal names. It can settle before output or observed descendants finish. The protocol client's new `exited` promise supplies this fact; existing pipe `done` retains its final-collection behavior. |
| `output` | Ordered raw bytes through a Node `Readable`; its end follows queued output. Reconnect resumes original offsets. Missing bytes or interrupted drain produce an error. |
| `inspectForeground` | Target foreground group, with `inputWaiting: false` meaning no exact input-wait proof. A confirmed root exit or absent group returns undefined. Other inspection failures propagate. |
| `signalForeground` | Maps DSH's `SIG*` names to the helper's portable names, targets the currently observed foreground group and returns the confirmed addressed group. A group can disappear before delivery; that failure propagates, without pretending that a signal was sent. |
| `terminate` | Idempotently closes admission, cancels blocked input/operations, requests TERM-to-KILL cleanup, and waits for in-flight operations and helper-confirmed observable-session quiescence. Signal acceptance alone is insufficient. It preserves unread output. |
| `dispose` | Provider teardown first terminates. Flowing consumers finish their output drain; otherwise unread output is explicitly abandoned with an error before release. This avoids stranding DSH's wait for terminal output completion. |
| `resize(rows, cols)` | Extension on the concrete `SshTerminal` handle; dimensions must be 1..65535. The pinned DSH seam and terminal tools expose no resize method, so no UI resize support is implied. |

The helper's cleanup scope remains `observed-session-members`. It cannot promise recovery of arbitrary descendants that deliberately detach. Root exit, output closure and cleanup completion remain separate observations. A permanent helper/transport loss rejects unobserved exit/output work and leaves cleanup unconfirmed; no replacement runtime automatically repeats the command.

## Bounds and background ownership

PTY raw retention is 64 KiB at the helper. The adapter uses a 32 KiB Node high-water mark plus bounded in-flight chunks. Acknowledgements follow downstream consumption, and a paused reader eventually blocks the producer. Reconnection preserves the same bounded helper output window. Once the helper's drain deadline interrupts output, the resulting incompleteness is an error, not successful truncation.

The Bash profile retains at most 1 MiB / 10,000 scrollback lines and returns at most 64 KiB per viewport/read/tool result, reporting truncation through the actual DSH consumer. One send waits at most 30 seconds; idle inference uses 500 ms of silence and a 200 ms prompt-handoff allowance. Exact syscall input-wait probing is unavailable; DSH may still recognize its controlled Bash prompt. These readiness results are not arbitrary process-exit evidence.

Background sends use the real local jobs registry, with at most 10 active jobs per Agent and quiet completion delivery. A job owns a send operation within a terminal; the terminal remains an Agent-owned resource after the send settles. `completed` can mean the send returned readiness, inferred idle or timeout, and does not mean every foreground or descendant process exited. `job_kill` requests foreground interruption; `terminal_close` performs terminal-session cleanup. Agent disposal cancels its jobs and closes its terminals without stopping another Agent's resources in the shared runtime.

Terminal state and job records are live local/runtime resources, not durable task recovery. DSH owns Session persistence. This project no longer supplies a Session backend or claims safe cross-restart World reconstruction; see [upstream boundaries](upstream-seams.md). Helper restart recovery remains unsupported.

## Reproduce acceptance

Use the unchanged pinned DSH checkout and explicit target-native artifacts:

```sh
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE" terminal
DSH_TEST_RG="$LOCAL_RG" DSH_TEST_TERMINAL_SHELL=bash node target/composition/terminal.mjs
```

Native acceptance uses the local helper/fixture paths described in [Agent validation](agents.md). SSH acceptance additionally supplies `DSH_TEST_HOST`, `DSH_TEST_REMOTE_FIXTURE`, `DSH_TEST_BOOTSTRAP_MANIFEST` and an absolute `DSH_TEST_ARTIFACT_CACHE`. Omit `DSH_TEST_TERMINAL_SHELL` only for the platform profile expected to lack Bash; the suite verifies that absence explicitly. Keep private connection mappings outside repository artifacts.

The suite covers exact PTY byte delivery, dimensions, reconnect, blocked input cancellation, backpressure, cleanup after root exit, late allocation cancellation, slot reuse, unread-output provider disposal and missing-shell rollback. Bash-capable platforms additionally exercise actual terminal/job tools, cross-Agent isolation, interruption, peer survival and final output on shell exit. Permanent helper loss is injected in the native adapter test. This is source-seam acceptance, not a production package or UI release.
