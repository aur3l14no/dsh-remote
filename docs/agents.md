# Execution Worlds in DSH presets

The integration uses DSH's existing Agent registry, loop, tools, presets and subagent driver, unchanged at revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`. This project supplies the remote runtime, FS/subprocess/PTY providers and World context. It does not define Agent creation, delegation, tool filtering, handoff or Session storage.

## Standing composition

The application places a World and its consumers in an isolated group inside a DSH `agent.cordis.yml` preset. DSH mounts the preset once; Agents join that standing composition. Tools register in the preset scope, not in each Agent's own scope. A subagent's existing `composeFrom` call joins the same preset generation and inherits the same provider and tool instances. DSH's ordinary allow/deny filters apply to those inherited tools.

This follows E2B's provider/consumer split. Our earlier per-Agent tool registration caused the filter conflict. The custom Agent registry, ToolRuntime, handoff method, argv tool, Agent-specific World pool and SQLite Session backend have been removed. Application composition belongs in the fixture `tests/integration/preset-harness.ts`, not in a second harness shipped by the plugin.

A [persistent Session-based router](session-routing.md) supports multiple Worlds under one preset. The composition described below remains the lower-level single-World implementation.

The application uses normal DSH APIs:

```ts
await ctx.agents.create({
  sessionId,
  meta: { cwd: selectedWorldCwd, agentPreset: selectedPreset },
  setup: async agentCtx => {
    await ctx.agentPresets.mount(agentCtx, selectedPreset);
  },
});
```

World readiness belongs in awaited provider setup. The fixture supplies already-bootstrapped clients and maps DSH's exact packaged ripgrep identity to the deployed remote executable. Wiring bootstrap into an independently installable Loader configuration remains work; this is a source composition experiment.

## World context and ownership

`context.ts` observes DSH's existing `agent/created` event to record only the Agent's live World identity. Missing/unavailable Worlds or mismatched cwd throw during publication; DSH performs rollback. Children join the same preset observer through DSH's own composition. No Agent factory or subagent behavior is replaced.

`worldContextFor(ctx, agentOrExecution)` uses DSH's public `serviceForAgent`, checks the live binding, and returns World/runtime IDs, remote cwd, platform, capabilities and connection state. The system prompt and Auto Approval can read these facts without SSH arguments or resume tokens. An existing Agent cannot silently change its bound World/runtime/cwd. The context plugin registers no tools and implements no tool filters.

This lower-level context plugin provides a **live binding**. Durable binding and restart validation use the separate [JSON sidecar and shared router](session-routing.md), with DSH's original Session backend. No previous experimental SQLite files are migrated or deleted; the removed backend remains available only in Git history.

Providers are shared by joined Agents. DSH consumers own Agent-specific lifetimes: terminal/job registries close the appropriate owner's work without terminating peers. Direct subprocess specs carry no Agent owner in the pinned seam; callers must close their handles. Provider/World disposal is the final cleanup boundary. This project does not infer ownership by rebuilding an Agent manager.

The known upstream `tool-fs` branch for `..` calls local `realpath` before reaching the FS seam. The World guard refuses that branch explicitly, without rewriting tool registrations or silently using local filesystems. Normal file/search tools remain DSH implementations.

## Validation

The fixture verifies real parent/child file calls, identical inherited provider/tool instances, native allow/deny/empty filters, two Worlds, publication rollback for an invalid cwd, and refusal of local-realpath bypass. It tests DSH consumers to check the World boundary, not to implement their behavior. See [current evidence](preset-acceptance-results.json).

```sh
node scripts/check-composition.mjs "$DSH_SOURCE"
node scripts/build-composition.mjs "$DSH_SOURCE" agents
DSH_TEST_RG="$LOCAL_RG" node target/composition/agents.mjs
```

Native acceptance needs native helper/fixture artifacts. SSH acceptance additionally supplies `DSH_TEST_HOST`, `DSH_TEST_BOOTSTRAP_MANIFEST`, an absolute `DSH_TEST_ARTIFACT_CACHE`, and target fixture paths for terminal tests. Private connection mappings stay outside repository artifacts. Prior Agent/terminal JSON reports describe historical commits and do not establish compatibility of removed custom services.
