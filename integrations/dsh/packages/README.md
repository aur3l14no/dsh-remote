# DSH packages

Source modules are grouped by subsystem, then implementation. They are built into one native extension bundle; directory boundaries do not imply independent npm publication or a single Cordis instance.

| Module | Ownership |
| --- | --- |
| `world/ssh-world` | World connections, immutable Session bindings, FS/subprocess providers, tool routing, terminal backend and SSH account policy |
| `workspace/portable-workspace` | Registry, Remote API/feed, browser UI, Session admission, file references and previews |
| `skill/remote-skills` | Remote instructions/skill discovery, deployment and automatic/manual synchronization |
| `bundle/remote` | Host composition and service activation order |

`bundle/remote/src/index.ts` mounts skill synchronization and World ownership, publishes the workspace feed, then mounts the registry and consumers. The feed must be active before the registry releases the controller. The [overlay and preset](../packaging/extension/README.md) mount native services and isolated tool routers separately. Browser code stays with workspace at `workspace/portable-workspace/src/client/index.tsx`.

The world module's `terminal.ts` implements the remote terminal runtime; `terminal-backend.ts` adapts native DSH terminal tools to it. Small adapters remain files with their own Cordis lifecycle; grouping them does not merge service scopes.

Cross-module cancellation support lives in `../shared/lifetime.ts`, not in Skills. Shared execution and transport that do not depend on DSH remain under `runtime/`. See [architecture](../../../docs/architecture.md) and [execution boundaries](../../../docs/execution-boundaries.md).

Use kebab-case for new source paths, camelCase for TypeScript values, and PascalCase for types. Persisted keys, wire fields and installed public module identities retain their compatibility contracts. Existing test/evidence names are not renamed as part of this package migration.

The low-level SSH package remains an unchanged-source compatibility fixture. Users install the [single extension bundle](../../../docs/install.md).
