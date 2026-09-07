# Delivery direction within existing DSH interfaces

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

Status: recommendation for the next iteration, not an implemented entry point or an approved change to the final multi-World design. Source conclusions use unchanged DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215` and this repository's acceptance results.

## Recommendation

Continue with DSH for one bounded usability milestone: an external entry plugin, launched by an ordinary DSH profile, prepares one explicit World/workspace and drives native DSH Agent APIs. Start with command-line task submission and explicit Session resume. Run separate local DSH processes for simultaneous Worlds. Keep the single shared preset definition parameterized by runtime selection; do not generate a preset per World.

This deliberately narrows the initial delivery surface. It assumes command-line submission is acceptable for the first usable version; interactive Web chat remains deferred. If Web chat is essential to that version, the entry experiment alone cannot satisfy the product requirement.

The next question is whether a real user can complete a remote coding task. More helper features, release automation or a polished acceptance report do not answer that question by themselves.

| Direction | Decision | Reason |
| --- | --- | --- |
| Small adaptation through public APIs | Try now, with an explicit scope and exit gate | Prepared root creation/resume and concrete providers already work in composition fixtures. |
| One World/workspace per local DSH process | Proposed initial deployment limit | Concrete providers are available during startup and background work; different Worlds do not share ambient initialization. Costs extra processes and forfeits unified navigation. |
| Full Web Project integration | Defer | Unprepared create/resume paths bypass World preparation. A partial UI would conceal unsupported entry paths. |
| Main Agent coordinating independent World Sessions | Defer | No verified existing cross-root messaging composition meets the same-World child rule. |
| Wait for upstream | Not a delivery strategy | No upstream change is assumed or scheduled. Recheck relevant interfaces only when deliberately evaluating a new baseline. |
| Change agent framework | Contingency after the usability gate | A new host must prove the missing interfaces; switching alone does not guarantee them. |
| Build an agent harness | Last resort, separate decision | Would take ownership of models, loops, Sessions, delegation and presentation. No such work is proposed now. |

## Existing seams and proposed wiring

DSH's [profile composition](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/boot/app-boot/src/profile.ts) supports external plugin packages and patch layers. Public Agent APIs expose awaited setup. The [Project experiment](../../../../integrations/dsh/experiments/portable_workspace/README.md) proves explicit binding before native creation/resume and the [terminal fixture](terminal.md) proves concrete World providers under native owner-aware terminal/jobs consumers.

The shipped [headless runner](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/bundle/headless/src/index.ts) still creates a root with `process.cwd()` and no preset mount. The pinned SDK server also owns root creation without the required binding/preset setup. Neither is an already working remote entry. The proposal replaces the **entry plugin row**, not the Agent factory, loop or Session backend.

The external entry would:

1. Read an explicit World/workspace selection, or resolve a saved Session binding. Keep launch/configuration directories local and Session cwd remote; never create a local stand-in for the remote directory.
2. Bootstrap the selected final environment, remotely canonicalize/check the workspace, and prepare the helper, ripgrep and requested shell capabilities. Reuse the existing binding format; environment catalog and concrete workspace identities must stay distinct.
3. Finish concrete FS/subprocess/terminal provider setup before Agent publication. Enforce one immutable selected World/workspace for this process; reject mismatched roots or resumes even when paths happen to match. This is explicit composition, never fallback when a router lacks context.
4. Commit the root Session binding, then call native `agents.create()` or `agents.resume()` with the standing preset. Children use DSH's existing drivers, same-World inheritance, filters and owner cleanup.
5. Submit user input through the native Agent interface, forward DSH output/events, and let DSH persist the Session. Interruption and shutdown use existing Agent/consumer disposal contracts. Reopening history starts a new helper without replaying old commands or restoring tasks.

Implementation belongs in a separate small entry/composition package. The execution package owns providers and bindings. The entry has no independent Agent registry, message queue, conversation format, tool-filter policy, subagent implementation or scheduling loop.

Use one reusable profile/preset. A local configuration/catalog or invocation selection may vary per run. The first process owns one root and its native descendants; multiple independent Worlds use independent local processes. Existing tested multi-World routing stays available for further work, but is not required to pass this initial delivery gate.

## Adaptation limits

| Capability | Initial handling |
| --- | --- |
| File read/write/edit/search | Existing DSH consumers over remote providers; retain explicit refusal of the upstream `..` branch. Absolute and ordinary workspace-relative paths remain usable. Never lexically remove `..` across possible symlinks. |
| Shell/PTY and background jobs | Concrete World providers and native terminal/jobs consumers. Probe required shell remotely; a platform missing Bash does not receive a successful Bash-tool claim. |
| Initialization and non-tool calls | Concrete selected World available before consumers mount; no implicit default in the shared router. Verify consumer callbacks and disposal through completion. |
| Session resume | Explicit entry command prepares the saved binding before native resume. Direct Web links and automatic Web activation are outside this delivery surface. |
| Child binding commit failure | Retain execution-blocking behavior and its known publication limitation. No replacement child manager. |
| Additional plugins | Initially compose a documented set whose workspace access was verified. Disable incompatible optional workspace consumers. Local model/config/history operations remain local. |

Do not mount an entire local-oriented bundle blindly. In particular, inspect workspace discovery, project instructions/skills, Git/LSP, shell detection and upload/file-reference paths before enabling them. A mandatory consumer that bypasses World is a blocker; an optional one can be omitted explicitly. Auto Approval remains a separate assumed plugin, with the selected World visible in its input.

Reject filesystem monkey-patches, fabricated local workspaces, wrappers around private Session Controller fields, per-Agent tool re-registration and remote-only tool names that leave other workspace tools executing locally.

## Next iteration and exit gate

First build one reproducible **real DSH profile** installation with the external packages. Pin a coherent source-built baseline if necessary; a hand-built `Context` fixture or tarball import alone is not this gate. Do not mix incompatible published versions to claim an installation success. The upstream [developer-preview notice](https://github.com/deepseek-ai/deepseek-harness#developer-preview) explicitly warns about breaking changes, so automatic upgrades are outside the initial contract.

Then run a small remote coding task through that entry, using the native model loop and actual tool consumers:

- Read/search a fixture repository, edit a file and run its validation remotely.
- Start a long-running command, observe output and cancel it; preserve the distinction between request acceptance and confirmed cleanup.
- Use an existing DSH child and verify World inheritance, native filtering and owner isolation.
- Exercise same-runtime reconnect; restart DSH and explicitly resume the saved Session into a new runtime, without task replay.
- Run two processes against different Worlds containing the same path; verify different contents and no local workspace side effects.
- Missing World, changed selection, missing required shell and connection loss must fail explicitly. Model output and Session history remain local.

A deterministic model fixture can first test the profile wiring; a real-model smoke run then establishes actual usability. The initial full task should use a Bash-capable Linux target. Embedded Linux lacking Bash retains the verified helper/FS/subprocess coverage and an explicit consumer limitation; macOS remains the local/native acceptance platform. Do not install a different shell merely to hide an unsupported platform claim.

Pass: deliver a developer alpha with one reusable profile, concise setup/resume instructions and the supported-consumer matrix. Next simplify configuration/bootstrap and generate a one-page report from measured results. General resolver composition and unified multi-World UI stay later work.

Fail: stop this DSH entry attempt if it requires changing Agent/Session ownership, using private host internals, allowing local workspace access, or if no reproducible real profile can be assembled. Record the exact blocking path. Do not use more helper work or UI work to postpone that decision.

## When to reconsider the host

Decide by impact, not issue count. Missing Project UI or cross-root messaging can remain omitted. Inability to perform ordinary remote edits, execute/cancel owned processes, resume a Session safely, or preserve child World context undermines the core product and justifies evaluating alternatives.

At that point compare at most two candidate hosts using the same helper/client and task fixture. Require replaceable workspace FS/process capabilities, awaited create/resume admission, child context inheritance, owner-aware cancellation and a usable local entry. Adopt a new host only after its small end-to-end proof passes; do not infer suitability from a framework's plugin or multi-agent marketing.

Keep the existing Rust helper and protocol/client independent of DSH. That separation already preserves reuse; no speculative multi-framework abstraction or self-built harness is needed now. If suitable hosts still fail and the user wants the full experience, evaluate self-development as a new project with its own scope.
