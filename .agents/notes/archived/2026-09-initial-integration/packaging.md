# External plugin package

> Historical record, archived 2026-09-07. Earlier no-patch/deferred-Web decisions are superseded by the active World Project plan. Paths and links were relocated; acceptance claims describe their original runs. See [current plan](../../proposed/integration/2026-09-07-world-portable_workspace-web.md).

`@dsh-remote/ssh-world@0.1.0-alpha.2` is a private development tarball. It contains this project's compiled implementation, type declarations and Loader entry points. DSH/Cordis remain external dependencies. Helper and ripgrep binaries are supplied through the existing trusted manifest/cache workflow. Alpha.2 adds the optional pinned [Podman entry](podman.md).

```sh
node integrations/dsh/scripts/pack-plugin.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/check-plugin.mjs "$DSH_SOURCE"
DSH_TEST_PACKAGED=1 DSH_TEST_RG_MODE=npm DSH_TEST_RG="$LOCAL_RG" \
  node target/package-check/accept.mjs
```

Output: `target/packages/dsh-remote-ssh-world-0.1.0-alpha.2.tgz`. The [package README](../../../../integrations/dsh/tests/packaging/ssh-fixture.md) documents module names, service configuration and the shared preset. `pack-plugin.mjs` emits JavaScript with shared chunks so routers, World service and exported protocol client retain one module identity. It includes no DSH source and emits only this project's declarations.

## Validation boundary

The test unpacks the tarball into a clean fixture directory. It loads the router modules by package name through Cordis Loader; SSH acceptance also loads the World service by package name and uses its ordinary bootstrap. Host services come from unchanged DSH source revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`; shared host modules stay external. The fixture checks that no plugin implementation source is bundled into the host.

Export/type checks use the unpacked declarations. Runtime checks cover the existing persistent-binding suite and DSH's ordinary `@vscode/ripgrep@1.18.0` resolver branch. That local executable identity maps to the target-native managed ripgrep; search still executes remotely. Native acceptance explicitly injects a resolver using the package's own exported protocol client.

Alpha.1 acceptance on 2026-09-06 passed all five groups on native macOS, embedded Linux and container Linux (15 total), plus 23 default tests with two environment-selected skips. Its [tarball integrity, source hashes and evidence](evidence/package-acceptance-results.json) describe that earlier artifact, not subsequent builds.

Alpha.2 passed declaration checks and all five packaged routing groups over SSH → Podman exec on Linux/glibc, including ordinary npm ripgrep resolution and restart into the saved container World. Its [separate evidence](evidence/podman-acceptance-results.json) records the new tarball digest and preserves the narrower platform coverage.

This establishes tarball/Loader compatibility with the pinned source-built fixture. It does not establish compatibility with an installed public DSH distribution or a complete UI preset. The npm registry check on 2026-09-06 found no `@deepseek-ai/dsh-agent-presets@0.1.3-alpha.1`; public `latest` tags across DSH packages were inconsistent. Exact source-version peer dependencies remain in the manifest, rather than claiming an older release compatible. No npm package or public release has been published.

Terminal/job initialization through the shared router remains deferred. Parent-path requests and child binding-commit failure retain the documented [behavior](2026-09-07-decisions.md).
