import { Context } from '@deepseek-ai/cordis';
import { type Client, RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { bootstrapSshWorld, type BootstrapOptions } from '../../../../../../runtime/ssh/src/index.ts';
import type { SshWorkspaceDefinition } from '../../execution-world/src/identity.ts';
import { worldPlugin } from './world.ts';
import SshFileSystem from './fs.ts';
import SshSubprocess from './subprocess.ts';

export interface WorldConnection { client: Client; ripgrep: string; dataRoot?: string; close(): Promise<void> }
export type WorldConnector = (world: SshWorkspaceDefinition) => Promise<WorldConnection>;
export type BootstrapConfig = Pick<BootstrapOptions, 'manifest' | 'cacheDir' | 'required' | 'graceMs' | 'leaseMs' | 'connectTimeoutMs' | 'lockWaitMs'>;
export interface SshAdapterConfig {
  beforeConnect?: (world: SshWorkspaceDefinition) => Promise<void>;
  packagedRipgrep: string;
  bootstrap: BootstrapConfig | (() => Promise<BootstrapConfig>);
}

/** SSH-only provisioning and provider lifetime. Local Worlds never enter this adapter. */
export class SshWorldAdapter {
  private readonly connect: WorldConnector;
  private prepared?: BootstrapConfig;
  constructor(private readonly config: SshAdapterConfig, private readonly connector?: WorldConnector) {
    if (!config.packagedRipgrep.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Packaged ripgrep requires an absolute executable identity');
    this.prepared = typeof config.bootstrap === 'function' ? undefined : config.bootstrap;
    this.connect = connector ?? (async definition => {
      // The protocol world token identifies this concrete workspace runtime owner.
      const world = await bootstrapSshWorld({ ...this.prepared!, ...definition, world: definition.id });
      return { ...world, dataRoot: `${world.platform.home}/.local/share/dsh-remote` };
    });
  }
  /** Retryable preparation runs before a runtime is allocated. */
  async prepare(definition: SshWorkspaceDefinition): Promise<void> {
    await this.config.beforeConnect?.(definition);
    if (!this.connector && typeof this.config.bootstrap === 'function') this.prepared = await this.config.bootstrap();
  }
  async open(definition: SshWorkspaceDefinition): Promise<Context> {
    const connection = await this.connect(definition);
    const owner = new Context();
    let mounted = false;
    try {
      const info = connection.client.info;
      if (info.world !== definition.id || info.cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Negotiated World or canonical cwd differs from the binding');
      await owner.plugin(worldPlugin(connection.client, () => connection.close(), connection.dataRoot)); mounted = true;
      await owner.plugin(SshFileSystem, { textMaxBytes: 33554432, diffBasisMaxBytes: 1048576 });
      await owner.plugin(SshSubprocess, { executables: { [this.config.packagedRipgrep]: connection.ripgrep } });
      return owner;
    } catch (error) {
      try { await owner.fiber.dispose(); if (!mounted) await connection.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'World setup failed with unconfirmed cleanup'); }
      throw error;
    }
  }
  assertReady(owner: Context): void {
    if (owner.remoteWorld.client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Bound World is unavailable');
  }
}
