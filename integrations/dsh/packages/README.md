# DSH source modules

The source modules build into one extension bundle. Their directory boundaries do not merge Cordis lifecycles or imply independent npm publication.

| Module | Ownership and entry points |
| --- | --- |
| `world/execution-world` | World and workspace identity, Session bindings, provider dispatch, lifecycle and preset selection. |
| `world/local-world` | Native local FS/subprocess provider. |
| `world/ssh-world` | SSH bootstrap, helper client, remote FS/subprocess and account policy. `terminal.ts` implements the runtime; `terminal-backend.ts` adapts native tools. |
| `workspace/local-workspace` | Native registry isolation and local directory picker bridge. |
| `workspace/portable-workspace` | Workspace registry and membership, presentation state, API/feed, admission, file references and previews; browser entry is `src/client/index.tsx`. |
| `workspace/remote-attachments` | Session-scoped remote attachment authority and temporary host materialization; local bindings delegate to the native store, SSH rejects unqualified references. |
| `skill/remote-skills` | Project instructions/skill discovery, deployment and synchronization. |
| `bundle/remote` | Host composition and activation order in `src/index.ts`. |

Cross-module cancellation lives in `../shared/lifetime.ts`; generic execution belongs in `runtime/`. Service ordering and identity rules are maintained in [system map](../../../docs/system-map.md); native services and tool scopes in the [overlay/preset](../packaging/extension/README.md).

Use kebab-case for new source paths, camelCase for TypeScript values, and PascalCase for types. Research state supports only the current format; incompatible state is reset explicitly. Installed module identities must remain consistent within the built bundle. Historical test/evidence names need not follow source renames.
