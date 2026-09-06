# SSH Execution World for DSH

This private development package supplies World connections, persistent Session–World bindings, and shared FS/subprocess routing. DSH owns Agents, Session history, delegation and tool filtering. Model and UI work stay local; workspace operations use the selected remote helper.

It targets DSH source revision `d347e703908d0406b7a7ef80e3a0e594d86b2215` and Node 24. The corresponding DSH `0.1.3-alpha.1` packages are not available from npm at the time of preparation. Use a matching source-built host; published-package compatibility is not established. This package does not include DSH, helper binaries or ripgrep.

Cordis Loader entry points:

| Module | Responsibility |
| --- | --- |
| `@dsh-remote/ssh-world` | Shared `executionWorlds` service; configured with bindingFile, packagedRipgrep and trusted bootstrap manifest/cache. |
| `@dsh-remote/ssh-world/fs` | Filesystem router in the standing preset. |
| `@dsh-remote/ssh-world/subprocess` | Subprocess router in the standing preset. |
| `@dsh-remote/ssh-world/routing` | Tool dispatch, World context and binding checks in that same preset. |
| `@dsh-remote/ssh-world/bindings` | Explicit local `BindingStore.create` initialization. |
| `@dsh-remote/ssh-world/client` | Protocol client for an explicit custom resolver; use this copy with `executionWorldsPlugin`. |

Before normal DSH creation, the host calls `await ctx.executionWorlds.bind(sessionId, { id: worldId, kind: 'ssh', host, cwd })`. Cwd must be the canonical remote workspace. Before normal DSH resume, it calls `await ctx.executionWorlds.prepare(sessionId)`. The host then uses DSH's usual preset mount and Agent APIs. The plugin neither chooses Agent behavior nor installs a replacement factory.

In alpha.2, optional `podmanContainer` selects a running container on the SSH host using its full 64-character lowercase hexadecimal ID. Control, artifact upload and helper protocol all run through `podman exec -i`; container SSH is unnecessary. Paths refer to the container. Names/short IDs are refused, and container removal never selects the host or a replacement container. The caller owns container lifecycle; this is one optional Podman step, not a general resolver system.

Load the routers and existing DSH file/search tools together in an isolated standing preset. The shared World service stays outside that preset, so many Worlds use one preset. `executionWorldContext(ctx, agentOrExecution)` supplies the same World facts to model context and approval. Calls outside tool dispatch must explicitly select a bound Agent's concrete providers.

The shared `agent.cordis.yml` contains:

```yaml
- id: world-tools
  name: cordis:group
  isolate:
    fs: true
    subprocess: true
  config:
    - id: fs
      name: '@dsh-remote/ssh-world/fs'
    - id: subprocess
      name: '@dsh-remote/ssh-world/subprocess'
    - id: world-context
      name: '@dsh-remote/ssh-world/routing'
    - id: files
      name: '@deepseek-ai/dsh-tool-fs'
    - id: search
      name: '@deepseek-ai/dsh-tool-fs-search'
```

The host must supply DSH's normal core services and register `cordis:group` as usual. It resolves its own packaged ripgrep identity with `resolveRgPath()`; the World service maps that identity to each remote installation. This applies to both bundled-sidecar and ordinary npm-package resolution.

Known limits: parent-path requests are refused due to upstream local realpath use; child binding commit failure can leave a published but execution-blocked Agent; interrupted mapping writes may need verified manual lock cleanup. Shared-router terminal/job initialization and release distribution remain separate work. OpenSSH retains its normal configuration, authentication and host verification behavior.
