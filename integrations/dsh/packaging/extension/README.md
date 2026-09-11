# Remote Web composition

`cordis.patch.yml` is the host overlay; `presets/remote/agent.cordis.yml` is the standing Agent preset. The build places them at the bundle root and under `presets/remote/`, respectively. Relative imports address installed compatibility artifacts. Install the prebuilt bundle using the [README](../../../../README.md); this directory is a source template.

The overlay replaces local workspace discovery/navigation and related controllers with the World registry and admission adapter. The local provider retains native directory selection and sandbox behavior. The SSH preset excludes same-cwd Session references, host file references, desktop path opening, local sandbox runners and unadapted consumers. The remote preset groups FS/subprocess/shell/workdir services with native file/search, Bash/jobs, Web/skill, instructions, subagent and terminal consumers. Activation and module identity rules are in [system map](../../../../docs/system-map-1.md).

Bash requests a 4 MiB spill cap per stream within the helper's 64 MiB runtime budget. Release refunds unused reservation; retained spill files stay charged until runtime cleanup. File completion scans at most 50,000 entries, excludes native ignored names and paths outside the canonical root, and returns up to 20 candidates.

## Host configuration

`$DSH_HOME/remote/worlds.json` contains the editable `worlds` catalog: `{id, name, target, color?, workspaces?, skills?, enabledSkills?}`. Each workspace declares `{path, name?}`. Initialization may seed the catalog from `config.json`; later startup reads the separate catalog. This initializes configuration only, never historical Session bindings. Running Web clients offer **Reload worlds** with a read-only preview and explicit apply. See [World configuration](../../../../docs/worlds.md).

`$DSH_HOME/remote/config.json` retains runtime control configuration:

| Field | Input |
| --- | --- |
| `worlds` | Initial catalog input when `worlds.json` is absent; ignored once the separate catalog exists. Target accepts `{kind:"ssh", host}` and optional `configFile`, `installRoot`, `runtimeBase`, or full immutable `podmanContainer` ID. |
| `bindingFile` | Absolute path to an initialized private local [BindingStore](../../../../docs/reference/session-bindings.md). Initialization creates it; normal startup only opens it. |
| `bootstrap` | Optional offline override `{manifest, cacheDir}`; when absent, the extension downloads its versioned runtime automatically. Explicit artifacts follow [bootstrap](../../../../docs/reference/bootstrap.md). |

World registration accepts an existing absolute directory. Navigation preserves `?session=…`; cold activation uses the saved binding. Blank Sessions can only be reused in their registered workspace. Fork retains the binding and conversation boundary.

Runtime permissions, unsupported consumers and preview semantics are maintained in [system map](../../../../docs/system-map-1.md); synchronization in [Skills](../../../../docs/skills.md); installation checks in [E2E](../../tests/e2e/README.md).
