# DSH plugins

These TypeScript modules run in the local DSH host; workspace operations reach the remote helper through `ssh-world`. They are assembled into one native extension bundle, not published as one package per directory.

| Directory | Responsibility |
| --- | --- |
| `extension/` | Host composition entry: mount services in dependency order; no workspace domain logic |
| `ssh-world/` | World connections, immutable Session bindings, filesystem/subprocess providers and tool routing |
| `portable_workspace/` | World × canonical workspace registry, Remote API/feed and browser navigation |
| `session-admission/` | Validate and prepare bindings before native Session lifecycle operations |
| `skills/` | Remote instructions/skill discovery, deployment and automatic/manual synchronization |
| `account-policy/` | Explicit SSH account permission policy |
| `terminal/` | Remote backend for native terminal tools |
| `file-references/` | Agent-owned remote file completion |
| `file-preview/` | Session/Agent-owned filesystem resolvers for native previews |

`extension/src/index.ts` mounts the World owner and skill synchronizer, publishes the workspace feed, then mounts the registry and consumers. The feed must be active before the registry releases the controller. The overlay and remote preset separately mount native services and isolated tool routers; see [profiles](../profiles/README.md).

The build preserves the installed extension entry and browser module identity. `portable_workspace/src/client/index.tsx` remains the browser entry. The low-level SSH package is a compatibility test fixture; user installation uses the [extension bundle](../../../docs/install.md).

Keep DSH APIs here. Shared transport and execution code belongs in `runtime/`; follow [execution boundaries](../../../docs/execution-boundaries.md).
