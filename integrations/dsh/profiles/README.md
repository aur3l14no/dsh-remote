# Remote Web composition

`remote/cordis.patch.yml` is the host overlay; `remote/agent.cordis.yml` is its standing Agent preset. Use them with the pinned patched source and the generated Web plugin packages. This is a source-composition entry, not a published Web npm distribution.

| Owner | Mounted behavior |
| --- | --- |
| DSH host | Native model route, Agent/Session, JSONL, browser transport, tool registry/filtering and local Web connector |
| portable_workspace plugin | World catalog, canonical remote directory registration, immutable membership, durable feed and browser selection/navigation |
| session-admission plugin | Prepare and validate the saved binding before create/adopt/resume/fork |
| remote preset | Isolated FS/subprocess/shell/workdir services; native read/write/edit, grep/glob, foreground/background Bash, jobs, Web/skill tools, remote instructions, native subagents and terminal tools |
| Linux World | Workspace files, Git repository, commands and helper-owned process state |

The overlay excludes native local Workspace discovery/navigation, directory picking, same-cwd Session references, local file references and local sandbox runners. It disables the native desktop path opener and discovery of unadapted presets. Bash requests a 4 MiB spill cap per stream, leaving room for concurrent jobs within the helper's 64 MiB runtime budget. Release refunds unused capacity; retained output files remain charged until runtime cleanup. Unsupported resource requests still fail explicitly.

Host configuration is supplied as `DSH_REMOTE_CONFIG`: `{worlds, bindingFile, bootstrap}`. `worlds` contains explicit catalog entries; `bindingFile` must be an initialized private local BindingStore; `bootstrap` supplies the trusted platform manifest and artifact cache. The E2E launcher creates these inputs without reading private developer targets.

World registration accepts an existing absolute directory. Browser navigation preserves `?session=…`; cold activation uses the saved binding. A blank Session may be reused only within its registered portable_workspace. Fork copies the native conversation boundary and retains the same binding; it does not create a Git worktree.

Remote file completion is mounted by an explicit Agent-owned provider. It scans at most 50,000 entries per query, excludes native ignored directory names and paths outside the canonical root, and returns up to 20 candidates. A dedicated terminal panel, attachment transfer and remote OS sandbox enforcement are outside this preset. Native attachment storage remains local. Do not add their default local consumers implicitly. A local skill's command still needs an explicitly supported capability; no general host shell is provided. Selected skill folders can be explicitly deployed into remote home using [the deployment command](../../../docs/skills.md); dependencies are maintained separately.

See [E2E commands](../tests/e2e/README.md), [execution boundaries](../../../docs/execution-boundaries.md), and [remaining plan](../../../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md).

Source installation and the native CLI launcher are documented in [source install](../../../docs/source-install.md). Parent and child Agents use the selected SSH account permissions; unsupported sandbox modes are rejected. Continuations retain the child identity and validate every persisted parent binding.
