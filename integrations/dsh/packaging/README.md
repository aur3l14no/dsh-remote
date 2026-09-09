# DSH packaging

User and developer installation use the same native `@dsh-remote/extension` bundle and official DSH CLI. See [README](../../../README.md) and [maintenance](../../../docs/development.md#离线产物与已有配置).

| Input | Purpose |
| --- | --- |
| `extension/setup.mjs` | Validate the supported host/package versions and load private remote configuration |
| `extension/config.mjs` | Initialize private configuration, optionally from a verified complete release |
| `official/package.json` and lockfile | Pin official build/test dependencies; not a user installer |
| `extension/cordis.patch.yml` and `extension/presets/remote/` | Installed bundle overlay and Agent preset |
| `../patches/series.json` | Authoritative upstream revision and ordered patch list |

`../scripts/build-extension.mjs` builds our plugins and patched compatibility packages into `.build/dsh/extension/` and emits the tarball described by `dist/dsh/extension-build.json`. It does not build the complete DSH host. Complete runtime archives and CI promotion are documented in [release](../../../docs/release.md).

The [SSH fixture](../tests/packaging/ssh-fixture.md) exists for unchanged-source package/import checks. It is not a second user delivery scheme. Build and validation commands are in the [development guide](../../../docs/development.md).
