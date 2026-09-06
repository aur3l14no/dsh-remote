# Persistent Session–World routing

`Tool call Agent → Session ID → binding file → World → remote client`

The external plugin implements this chain through DSH's public `tools/execute` hook and `AsyncLocalStorage`. A shared preset registers FS/subprocess routers and ordinary DSH tools once. Each World owns its concrete providers and SSH client. DSH's Agent registry, child driver, tool filters and JSONL Session backend are unchanged.

## Application integration

`bindings.ts` stores versioned JSON containing World definitions and Session-to-World IDs. Definitions contain only an immutable ID, `kind: ssh`, SSH host, canonical remote cwd, and optional SSH config/install/runtime paths. No Session history, helper runtime ID or resume token is stored.

Explicitly initialize the local file once with `BindingStore.create(bindingFile)`. Its parent directory must be private to the local account. Normal plugin startup opens the existing file and refuses a missing or malformed map.

```ts
await ctx.plugin(ExecutionWorlds, {
  bindingFile,
  packagedRipgrep: await resolveRgPath(),
  bootstrap: { manifest: trustedManifest, cacheDir },
});

// New Session: prepare its World and persist the selection before normal DSH creation.
const definition = await ctx.executionWorlds.bind(sessionId, {
  id: worldId, kind: 'ssh', host: sshHost, cwd: canonicalRemoteCwd,
});
await ctx.agents.create({
  sessionId,
  meta: { cwd: definition.cwd, agentPreset: presetId },
  setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, presetId); },
});

// Existing Session: reconstruct the World before normal DSH resume.
await ctx.executionWorlds.prepare(sessionId);
await ctx.agents.resume({
  resumeSessionId: sessionId,
  setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, presetId); },
});
```

The preset's isolated group loads `RoutedFileSystem`, `RoutedSubprocess`, the `routing.ts` context plugin and the ordinary DSH file/search tools. `ExecutionWorlds` is shared outside the preset; it does not define the preset or create Agents. `executionWorldContext(ctx, agentOrExecution)` exposes World facts to model context and approval. An owner-aware consumer outside tool dispatch may explicitly select concrete providers through `ctx.executionWorlds.forAgent(agent)`.

## Commit and recovery behavior

- Writes serialize under a local publication lock: write private temporary JSON, sync it, rename, then sync the directory. Readers see a complete generation. The file has a 4 MiB bound and contains no conversation data.
- World IDs and Session bindings cannot be reassigned by this API. Repeating an identical bind is safe; conflicting definitions fail before provisioning. SSH configuration and host verification remain under OpenSSH's authority; the record pins the selected alias/paths, not a separate remote-account identity.
- A fresh child inherits from DSH's parent Session metadata and commits at `agent/session-start`. Resume requires an existing row. A failed earlier publication leaves no inherited row. DSH contains errors from session-start observers: a failed child commit may leave a published Agent, but its model context and tool execution stay blocked. It never receives an uncommitted World.
- A root binding is a durable selection made before Agent creation. If later DSH creation fails, the binding remains for a same-World retry. Successfully committed rows also survive Agent disposal. No cross-file transaction with DSH Session storage or automatic row deletion is claimed.
- After application restart, `prepare` opens a new helper and validates its World/canonical cwd. Within one service lifetime, transport recovery stays with the same helper; failed Worlds are not automatically replaced. Stored bindings do not replay commands or recover tasks across helper restarts.
- Corrupt, missing, future-format or dangling records fail explicitly. A failed post-rename directory sync reports an uncertain commit and blocks that store instance until reopened. A killed writer may leave a lock/staging file; later writes report `BINDINGS_BUSY`. Recovery requires verifying the writer has stopped before removing its lock. The current complete JSON remains readable.

## Validation

`tests/bindings/store.test.ts` covers cross-process writes, immutable identities, malformed/missing records, pre/post-rename failures and a writer killed before publication. `tests/integration/session-routing.ts` runs separate harness processes using the actual DSH JSONL backend: concurrent read/grep, child binding/filter inheritance, blocked failed commits, restart into a new helper, and missing/conflicting binding refusal. DSH remains responsible for whether a particular child supports continuation.

Accepted on 2026-09-06: native macOS, SSH-connected embedded Linux and container Linux, five groups each. Default regression: 23 passed, two environment-selected skips. Both TypeScript checks passed. See [source hashes and platform evidence](binding-acceptance-results.json).

```sh
node --test tests/bindings/*.test.ts
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE" session-routing
DSH_TEST_RG="$LOCAL_RG" node target/composition/session-routing.mjs
```

Native acceptance uses native helper/fixture artifacts. SSH acceptance supplies `DSH_TEST_HOST`, `DSH_TEST_BOOTSTRAP_MANIFEST`, an absolute `DSH_TEST_ARTIFACT_CACHE`, and `DSH_TEST_REMOTE_FIXTURE`; private connection mappings stay outside the repository. The [package fixture](packaging.md) additionally loads the compiled tarball through Loader; the host remains built from pinned sources. Terminal/job initialization through the shared router remains separate work; parent-path requests remain explicitly refused.
