# Remote PTY and Session jobs

The external subprocess adapter implements the pinned DSH terminal primitive using helper 0.1.1 / API 1. An optional Agent profile composes the actual DSH terminal registry, Bash backend, terminal tools, local jobs registry and job tools. Neither DSH core nor the Rust helper changes in this milestone. See the [platform evidence](terminal-acceptance-results.json).

## Enable the consumer profile

After configuring the ordinary local services and external providers described in [Agent composition](agents.md), configure the registry with:

```ts
await ctx.plugin(WorldAgentRegistry, {
  worlds,
  terminal: { shell: 'bash' },
});
```

`shell` resolves through the selected World's remote executable resolver. Before Agent publication, a bounded remote probe verifies that the executable runs Bash. Missing Bash, missing terminal capability or a failed probe rejects creation and releases setup resources. There is no local PATH lookup or fallback. Omitting `terminal` retains the read/write/edit/glob/grep/exec profile; the subprocess PTY primitive remains usable by trusted World consumers without Bash.

The optional profile adds `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list`, `job_output`, `job_list` and `job_kill`. Every Agent receives isolated terminal, jobs and sandbox-policy services alongside its filesystem/subprocess services. Provider identities are checked before tool dispatch. The policy uses the SSH account's authority (`danger-full-access`) and the declared remote workspace. Auto Approval remains the assumed separate authorization boundary. Enabling this profile does not provide OS confinement or make arbitrary Node plugins safe.

The actual DSH backend, despite its local-oriented class names, allocates and controls processes exclusively through `ctx.subprocess`. Its terminal emulator, bounded scrollback and job bookkeeping stay local. PowerShell and other backends are not enabled. The full UI and independently installed package configuration are still outside the accepted source composition.

## Primitive semantics

| Operation or observation | Behavior |
| --- | --- |
| `spawnTerminal` | Asynchronous allocation of a real controlling PTY. Explicit argv, absolute remote cwd, environment, dimensions and cleanup grace. Exact managed executable mapping also applies here. |
| Allocation cancellation | A pre-aborted request allocates nothing. After admission, the client retains ownership while it resolves the same request journal; a late allocation is cleaned before cancellation returns. Cancellation is not permission to repeat spawn with a new ID. |
| Published handle lifetime | The allocation signal no longer owns the terminal after publication. Explicit termination or Agent/provider teardown owns its later cleanup. |
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

Terminal state and job records are live local/runtime resources, not durable task recovery. Local Session history remains checkpointed, but resuming history does not recreate an old terminal, adopt a job or re-execute a command. Helper restart recovery remains unsupported.

## Reproduce acceptance

Use the unchanged pinned DSH checkout and explicit target-native artifacts:

```sh
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE" terminal
DSH_TEST_RG="$LOCAL_RG" DSH_TEST_TERMINAL_SHELL=bash node target/composition/terminal.mjs
```

Native acceptance uses the local helper/fixture paths described in [Agent validation](agents.md). SSH acceptance additionally supplies `DSH_TEST_HOST`, `DSH_TEST_REMOTE_FIXTURE`, `DSH_TEST_BOOTSTRAP_MANIFEST` and an absolute `DSH_TEST_ARTIFACT_CACHE`. Omit `DSH_TEST_TERMINAL_SHELL` only for the platform profile expected to lack Bash; the suite verifies that absence explicitly. Keep private connection mappings outside repository artifacts.

The suite covers exact PTY byte delivery, dimensions, reconnect, blocked input cancellation, backpressure, cleanup after root exit, late allocation cancellation, slot reuse, unread-output disposal and missing-shell rollback. Bash-capable platforms additionally exercise actual terminal/job tools, cross-Agent isolation, interruption, peer survival and final output on shell exit. Permanent helper loss is injected in the native adapter test. This is source-seam acceptance, not a production package or UI release.
