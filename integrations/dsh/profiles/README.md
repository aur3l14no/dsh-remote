# Remote profile composition

No complete runnable remote Web profile is shipped yet. A composition fixture is not a profile installation.

The remote profile will select World-aware portable_workspace services, patched admission, a standing preset with remote providers and verified consumers, local model/history services, and explicit local connector capabilities. It must exclude unadapted local workspace discovery, file-reference/skill providers and local sandbox runners. Shell choice is based on the target environment, not process.platform of the local host.

A local web-search API client may remain local; a curl command issued through remote Shell runs remotely. Do not route by tool names or silently enable a general local shell. Preserve DSH's native tool filtering and surface truthful World facts to approval.

Add runnable config only after Loader + cold activation + browser acceptance. See [execution boundaries](../../../docs/execution-boundaries.md) and [phase plan](../../../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md).

## Initial admission fixture scope

This is the implemented patched-host fixture's consumer scope, not a production profile:

| Capability | Execution and current coverage |
| --- | --- |
| Agent/Session/model selection | Local native services; real JSONL and preset mounting, no real model request |
| portable_workspace selection | Explicit experimental registry; remote provider validates an existing canonical directory |
| Workspace files | Bound World FS provider and native file tools; no local cwd fallback |
| Lifecycle | Patched create/adopt/resume/observed activation/Typert lookups/fork, with explicit admission adapter |
| Shell/search/PTY | Existing independent provider/consumer fixtures; not expanded into the admission fixture |
| Web Search | Not mounted or verified yet; mandatory M1 connector boundary work remains |
| Instructions/skills/file references | Full remote discovery and non-tool propagation pending M4; do not add native local workspace providers implicitly |
| Upload/native desktop opener/worktree | Excluded from this fixture; a future remote profile must disable native workspace opening until adapted, and define explicit attachment transfer |
