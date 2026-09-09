# DSH packaging

User and developer installation use the same native `@dsh-remote/extension` bundle and official DSH CLI. See [installation and upgrades](../../../docs/install.md).

| Input | Purpose |
| --- | --- |
| `extension/config.mjs` | Validate the supported host/package versions and load private remote configuration |
| `extension/setup.mjs` | Implement the explicit configuration initialization command |
| `official/package.json` and lockfile | Pin official build/test dependencies; not a user installer |
| `extension/cordis.patch.yml` and `extension/presets/remote/` | Installed bundle overlay and Agent preset |
| `../patches/series.json` | Authoritative upstream revision and ordered patch list |

`../scripts/build-extension.mjs` builds our plugins and patched compatibility packages into `target/extension/` and emits the tarball described by `target/packages/extension-build.json`. It does not build the complete DSH host. CI uploads the extension and separately builds Linux helper candidates; public registry/release publishing is not implemented.

The [SSH fixture](../tests/packaging/ssh-fixture.md) exists for unchanged-source package/import checks. It is not a second user delivery scheme. Build and validation commands are in the [development guide](../../../docs/development.md).
