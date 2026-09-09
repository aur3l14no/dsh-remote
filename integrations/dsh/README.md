# DeepSeek Harness integration

DSH-specific code lives here; shared execution code and Rust stay in `../../runtime`.

- `plugins/`: World providers, portable_workspace, admission, skills, account policy, file references, previews and terminal integration.
- `patches/`: six maintained patches across nine packages; `series.json` pins the official revision and npm release. Unchanged-source and patched-host gates remain separate.
- `profiles/`: native bundle overlay and remote Agent preset templates. The build anchors their relative paths to installed artifacts.
- `packaging/extension/`: native bundle configuration and initialization command. Users install through `dsh plugin add` and start the official CLI.
- `packaging/official/`: locked official build/test inputs, not a user installer.
- `tests/` and `scripts/`: subsystem checks, prebuilds and Playwright/SSH acceptance.
- `experiments/portable_workspace/`: retained source-only proof of the original upstream gap.

See [installation](../../docs/install.md), [architecture](../../docs/architecture.md), [execution boundaries](../../docs/execution-boundaries.md), and [development](../../docs/development.md).
