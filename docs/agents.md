# Agent-bound SSH Worlds

Status: experimental external composition against DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`. The DSH source tree is unchanged. This milestone binds actual Agents and Sessions, in addition to the earlier Loader/provider experiment. See [acceptance evidence](agent-acceptance-results.json).

## Composition and ownership

The application loads `WorldToolRuntime` in place of the core tool service, `WorldSessionPersistence` as its local persistence provider, and `WorldAgentRegistry` in place of the core Agent registry. It retains the actual DSH Agent Loop, LLM runtime, Session store, projections and system-prompt service. The root must load those ordinary local services before starting the Agent Loop with `agents: []`.

`WorldAgentRegistry` takes immutable World declarations:

```ts
{
  id: 'ssh-workspace',
  target: 'deployment-environment-v1',
  cwd: '/workspace/project',
  open: () => bootstrapSshWorld({
    host: selectedSshHost,
    world: 'ssh-workspace',
    cwd: '/workspace/project',
    manifest: trustedManifest,
    cacheDir: absoluteLocalArtifactCache,
  }),
}
```

These paths and identifiers are illustrative. `target` is a caller-maintained opaque environment identity. It must change when the deployment changes environments. It is not a cryptographic host identity or an SSH alias-resolution fingerprint. OpenSSH remains responsible for server authentication. Secrets, SSH arguments, resume tokens and private connection mappings are excluded from the public binding.

The declared cwd must already be the canonical remote directory. Bootstrap's negotiated World and cwd must match it exactly; a discrepancy fails before publication. This keeps the Session header stable, since DSH snapshots metadata before its asynchronous setup hook. A future launcher may resolve a user-entered directory before making the declaration.

Each live Agent holds one lease on a World. Concurrent Agents share one startup and runtime, but receive independent FS/subprocess providers and process owners. The last lease closes the runtime. A failed or reconnecting runtime is never replaced on an existing Agent. After all leases close, an explicit later create/resume may bootstrap a new epoch.

Creation goes through `ctx.agents.create({ sessionId, world, ... })`. An Agent caller inherits its binding; a different explicit World is rejected. The actual in-process one-shot subagent driver uses this path. A root caller must select a World. `handoff(source, options)` requires a local root owner and creates a fresh Agent, copying only source Session/World provenance. It does not copy processes, implicit history, or dispose the source.

The pool installs rollback ownership before awaiting provisioning. If cancellation wins while bootstrap is pending, a late successful connection is still closed. Provider cleanup drains only that Agent's managed allocations before releasing its lease. Last-owner closure retains the helper's documented cleanup scope and unknown-outcome behavior; it cannot recover arbitrary detached descendants.

## Publication, context and consumers

Unpublished setup replaces and freezes the Agent's own public Cordis isolation map for `remoteWorld`, `fs` and `subprocess`, following the same isolation mechanism used by Loader. A dependency-declaring consumer plugin loads inside that realm. Local model calls, Session storage and UI services keep their existing realm.

The setup commit checks readiness and concrete provider identity. `WorldAgentRegistry.enter()` repeats that check at the actual registry boundary. This second check matters: the inspected Agent Loop awaits persistence after `setup.commit()` and before entering the registries. Direct/configured factory calls without a binding also fail there, before announcements.

The immutable public binding contains schema version, owning Session, World ID/target/cwd, runtime epoch, helper build, platform, architecture and capabilities. A dynamic system-prompt context adds current connection state. `contextFor(agentOrToolExecution)` exposes the same read-only metadata to Auto Approval. It neither mutates DSH's immutable execution identity nor supplies approval policy. `scopeFor(agent)` gives trusted local consumers the Agent-owned context with declared remote dependencies.

The verified profile exposes:

| Tool | Implementation and behavior |
| --- | --- |
| `read`, `write`, `edit` | Actual DSH file tools over the remote FS provider. Text matching, CRLF handling and diff rendering stay local. For a path containing `..`, `WorldToolRuntime` resolves it through the remote FS first, avoiding the pinned consumer's otherwise-local `realpath(cwd)` branch. Original approval/execution arguments remain intact. |
| `glob`, `grep` | Actual DSH search tools. The exact locally resolved packaged-ripgrep identity maps to uploaded target-native ripgrep; argv and `--no-config` behavior remain in DSH. No basename substitution. |
| `exec` | Small external foreground argv tool over the subprocess provider. It uses the immutable Session cwd, ignores stdin, has a 30-second deadline and 500-ms termination grace, and retains up to 64 KiB per collected output stream. Results retain loss/offset metadata. Shell syntax requires explicit shell argv. |

Inherited tools are hidden. A scoped monotonic guard rejects tools outside this profile; a registry guard rejects agentless, unbound or unavailable-World execution after approval. The fixture includes an executable local-tool trap and a local `realpath` trap. These are trusted same-process composition controls, not a JavaScript security sandbox: an arbitrary plugin with direct Node filesystem/process access remains trusted code and must be reviewed before inclusion.

The existing per-Agent registration layout does not support the pinned one-shot driver's `toolFilter`: ordinary DSH restrictions do not mask tools registered in the Agent's own layer. The external tool service therefore rejects every per-Agent filter with `UNSUPPORTED_TOOL_FILTER`, including an empty allow list; the fixture checks both named denial and empty allowance. Continuations, fork presets, structured-output subagent tools, unreviewed plugins and the complete application preset are not claimed compatible.

## Required local Session records

World ownership is stored as required `execution-world/bound` events; handoff has its own required provenance event. The binding's owning Session ID and the Session's fork-owned event range distinguish a Session's own records from inherited history. Resume requires an existing valid binding and an unchanged declared target/cwd. Unknown binding versions, missing bindings and changed identity fail before bootstrap. Stored runtime IDs are observations, not permission to recover or re-execute prior processes.

The pinned DSH JSONL reader's generated event catalog rejects unknown required external events. There is no public required-event registration seam. Marking World ownership `ignorable` would be incorrect. Consequently persistent Agent composition requires the external `WorldSessionPersistence`; a regular or missing provider is rejected before create/resume. This does not modify DSH's catalog or JSONL implementation.

The external backend uses Node's built-in SQLite with the explicit format `dsh-ssh-world-session/1`, in a caller-selected absolute **local** storage root. It stores ordinary DSH headers/events plus required World records. Ordinary unknown required vocabulary and unsupported World schemas are refused. Its files are separate from DSH JSONL; a JSONL-only deployment cannot resume them. JSONL import/export, migration and tooling that reads JSONL directly are outside this milestone.

Each Session has a private database and a separate SQLite lease database. A held exclusive lease transaction enforces one writer across processes; reads use the data database. OS process exit releases the lease, without a timeout takeover. Event batches commit atomically with SQLite `synchronous=FULL`. Published `session/event` records route to the owning writer, and `session/flush` reaches its durability barrier. Actual DSH checkpoint policy runs before model and tool dispatch. A live storage failure is sticky and reported by checkpoints and close, preventing subsequent dispatch.

This is a deliberately bounded initial backend: at most 64 MiB of serialized event records per Session, synchronous local writes, one file pair per Session, no migrations or garbage collection. Creation materializes metadata immediately, so an unpublished setup failure can leave an empty local Session artifact; it is not an active Agent and cannot resume without a valid World binding. Lease files are retained. Storage must be on a local filesystem with working SQLite locking; shared/network filesystems and power-loss behavior have not been accepted. Same-account file tampering is outside the exclusion guarantee.

## Validation and remaining scope

The suite uses the real DSH Agent Loop and deterministic local model adapter, captures actual model requests and durable tool results, drives the actual one-shot child driver, and restores the full history in a fresh local application. Linux runs use automatic SSH bootstrap with target-native helper/ripgrep; native macOS explicitly exercises its native helper. No model API request or UI integration is implied.

Build against the unchanged pinned checkout:

```sh
npm ci
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE" agents
DSH_TEST_RG="$LOCAL_RG" node target/composition/agents.mjs
node scripts/build-composition.mjs "$DSH_SOURCE" persistence
node target/composition/persistence.mjs
```

Native execution requires `target/debug/dsh-remote` and `dsh-remote-fixture`, or explicit `DSH_TEST_HELPER` / `DSH_TEST_FIXTURE`. SSH acceptance supplies `DSH_TEST_HOST`, `DSH_TEST_REMOTE_FIXTURE`, `DSH_TEST_BOOTSTRAP_MANIFEST` and an absolute `DSH_TEST_ARTIFACT_CACHE`; the local ripgrep is used solely to exercise DSH's bundled-sidecar identity resolver. Private connection settings belong outside repository artifacts.

The optional [terminal and Session-job profile](terminal.md) adds actual terminal/job consumers and remote PTY ownership. Remaining work includes subagent tool restrictions/continuations, complete application consumer review and independently installed package verification. The current helper protocol, reconnection semantics, filesystem size/listing limits and cleanup boundaries are unchanged. Release downloading, signed catalogs and installation garbage collection remain separate work.
