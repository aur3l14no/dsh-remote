# DSH source modules

The source modules build into one extension bundle. Their directory boundaries do not merge Cordis lifecycles or imply independent npm publication.

| Module | Ownership and entry points |
| --- | --- |
| `world/ssh-world` | Connections, Session bindings, FS/subprocess, routing and account policy. `terminal.ts` implements the runtime; `terminal-backend.ts` adapts native tools. |
| `workspace/portable-workspace` | Registry, API/feed, admission, file references and previews; browser entry is `src/client/index.tsx`. |
| `workspace/remote-attachments` | Session-scoped remote attachment authority, temporary host materialization and explicit legacy host references. |
| `skill/remote-skills` | Project instructions/skill discovery, deployment and synchronization. |
| `bundle/remote` | Host composition and activation order in `src/index.ts`. |

Cross-module cancellation lives in `../shared/lifetime.ts`; generic execution belongs in `runtime/`. Service ordering and identity rules are maintained in [architecture](../../../docs/architecture.md); native services and tool scopes in the [overlay/preset](../packaging/extension/README.md).

Use kebab-case for new source paths, camelCase for TypeScript values, and PascalCase for types. Persisted keys, wire fields and installed module identities retain their compatibility contracts; historical test/evidence names need not follow source renames.
