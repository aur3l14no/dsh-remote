# Remote Web composition

`cordis.patch.yml` is the host overlay; `presets/remote/agent.cordis.yml` is the standing Agent preset. The build places them at the bundle root and under `presets/remote/`, respectively. Relative imports address installed compatibility artifacts. Install the prebuilt bundle using the [installation guide](../../../../docs/install.md); this directory is a source template.

The overlay replaces local workspace discovery/navigation and related controllers with the World registry and admission adapter. It excludes the local directory picker, same-cwd Session references, local file references, desktop path opener, sandbox runners and unadapted presets. The remote preset groups FS/subprocess/shell/workdir services with native file/search, Bash/jobs, Web/skill, instructions, subagent and terminal consumers. Activation and module identity rules are in [architecture](../../../../docs/architecture.md).

Bash requests a 4 MiB spill cap per stream within the helper's 64 MiB runtime budget. Release refunds unused reservation; retained spill files stay charged until runtime cleanup. File completion scans at most 50,000 entries, excludes native ignored names and paths outside the canonical root, and returns up to 20 candidates.

## Host configuration

`$DSH_HOME/remote/config.json` contains:

| Field | Input |
| --- | --- |
| `worlds` | Catalog entries `{id, name, target, skills?}`. `target` contains `{kind:"ssh", host}` and optional `configFile`, `installRoot`, `runtimeBase`, or full immutable `podmanContainer` ID. Skills follow the [deployment format](../../../../docs/skills.md). |
| `bindingFile` | Absolute path to an initialized private local [BindingStore](../../../../docs/reference/session-bindings.md). Initialization creates it; normal startup only opens it. |
| `bootstrap` | `{manifest, cacheDir}`: trusted platform manifest and absolute local artifact cache, prepared through [bootstrap](../../../../docs/reference/bootstrap.md). |

World registration accepts an existing absolute directory. Navigation preserves `?session=…`; cold activation uses the saved binding. Blank Sessions can only be reused in their registered workspace. Fork retains the binding and conversation boundary.

Runtime permissions, unsupported consumers and preview semantics are maintained in [execution boundaries](../../../../docs/execution-boundaries.md); synchronization in [Skills](../../../../docs/skills.md); installation checks in [E2E](../../tests/e2e/README.md).
