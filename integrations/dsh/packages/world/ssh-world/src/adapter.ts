import BashExecutor from '@deepseek-ai/dsh-bash-local';
import { Context } from '@deepseek-ai/cordis';
import { type Client, RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { bootstrapSshWorld, type BootstrapOptions } from '../../../../../../runtime/ssh/src/index.ts';
import { worldOfWorkspace, type SshWorldDefinition, type SshWorkspaceDefinition } from '../../execution-world/src/identity.ts';
import { WorldRuntimePool } from './runtime-pool.ts';
import { workspacePlugin } from './workspace.ts';
import SshFileSystem from './fs.ts';
import SshSubprocess from './subprocess.ts';

export interface WorldConnection { client: Client; ripgrep: string; dataRoot?: string; close(): Promise<void> }
export type WorldConnector = (world: SshWorldDefinition) => Promise<WorldConnection>;
export type BootstrapConfig = Pick<BootstrapOptions, 'manifest' | 'cacheDir' | 'required' | 'graceMs' | 'leaseMs' | 'connectTimeoutMs' | 'lockWaitMs'>;
export interface SshAdapterConfig {
  beforeConnect?: (world: SshWorldDefinition) => Promise<void>;
  packagedRipgrep: string;
  bootstrap: BootstrapConfig | (() => Promise<BootstrapConfig>);
}

/** SSH-only provisioning and provider lifetime. Local Worlds never enter this adapter. */
export class SshWorldAdapter {
  private readonly runtimes: WorldRuntimePool;
  constructor(private readonly config: SshAdapterConfig, connector?: WorldConnector) {
    if (!config.packagedRipgrep.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Packaged ripgrep requires an absolute executable identity');
    const connect: WorldConnector = async definition => {
      await config.beforeConnect?.(definition);
      if (connector) return connector(definition);
      const prepared = typeof config.bootstrap === 'function' ? await config.bootstrap() : config.bootstrap;
      const world = await bootstrapSshWorld({ ...prepared, ...definition, world: definition.id });
      return { ...world, dataRoot: `${world.platform.home}/.local/share/dsh-remote` };
    };
    this.runtimes = new WorldRuntimePool(connect);
  }
  async open(definition: SshWorkspaceDefinition): Promise<Context> {
    const lease = await this.runtimes.acquire(worldOfWorkspace(definition) as SshWorldDefinition);
    const { connection } = lease;
    const owner = new Context();
    let mounted = false;
    try {
      await owner.plugin(workspacePlugin(connection.client, definition.cwd, () => lease.release(), connection.dataRoot)); mounted = true;
      await owner.plugin(SshFileSystem, { textMaxBytes: 33554432, diffBasisMaxBytes: 1048576 });
      const directory = await owner.fs.resolve('.', { cwd: definition.cwd });
      if ((await owner.fs.stat(directory))?.type !== 'directory') throw new RemoteError('NOT_DIRECTORY', 'Workspace cwd must name an existing directory');
      if (owner.fs.processPath(directory) !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Workspace cwd differs from its saved canonical directory');
      await owner.plugin(SshSubprocess, { executables: { [this.config.packagedRipgrep]: connection.ripgrep } });
      await owner.plugin(BashExecutor, { maxSpillBytes: 4194304 });
      return owner;
    } catch (error) {
      try { await owner.fiber.dispose(); if (!mounted) await lease.release(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'World setup failed with unconfirmed cleanup'); }
      throw error;
    }
  }
  assertReady(owner: Context): void {
    if (!owner.remoteWorkspace || owner.remoteWorkspace.client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Bound World is unavailable');
  }
}
