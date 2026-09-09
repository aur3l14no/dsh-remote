import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Client, RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { bootstrapSshWorld } from '../../../../../../runtime/ssh/src/index.ts';
import type { BootstrapOptions } from '../../../../../../runtime/ssh/src/index.ts';
import { BindingStore, worldDefinition } from './bindings.ts';
import type { WorldDefinition } from './bindings.ts';
import { worldPlugin } from './world.ts';
import SshFileSystem from './fs.ts';
import SshSubprocess from './subprocess.ts';

export interface WorldConnection { client: Client; ripgrep: string; dataRoot?: string; close(): Promise<void> }
export type WorldConnector = (world: WorldDefinition) => Promise<WorldConnection>;
export type BootstrapConfig = Pick<BootstrapOptions, 'manifest' | 'cacheDir' | 'required' | 'graceMs' | 'leaseMs' | 'connectTimeoutMs' | 'lockWaitMs'>;
export interface Config {
  beforeConnect?: (world: WorldDefinition) => Promise<void>;
  bindingFile: string;
  /** Exact identity returned by DSH's packaged ripgrep resolver. */
  packagedRipgrep: string;
  bootstrap: BootstrapConfig | (() => Promise<BootstrapConfig>);
}
interface OpenWorld { definition: WorldDefinition; ctx: Context }
declare module '@deepseek-ai/cordis' { interface Context { executionWorlds: ExecutionWorlds } }

/** Owns World connections and durable bindings, never Agent creation or Session history. */
export default class ExecutionWorlds extends Service {
  readonly bindings: BindingStore;
  private opening = new Map<string, Promise<OpenWorld>>();
  private ready = new Map<string, OpenWorld>();
  private live = new WeakMap<Agent, WorldDefinition>();
  private closed = false;
  private connect: WorldConnector;
  private beforeConnect?: Config['beforeConnect'];

  constructor(ctx: Context, config: Config, connector?: WorldConnector) {
    super(ctx, 'executionWorlds');
    this.bindings = new BindingStore(config.bindingFile);
    if (!config.packagedRipgrep.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Packaged ripgrep requires an absolute executable identity');
    const bootstrap = config.bootstrap;
    let prepared = typeof bootstrap === 'function' ? undefined : bootstrap;
    this.connect = connector ?? (async definition => {
      const world = await bootstrapSshWorld({ ...prepared!, ...definition, world: definition.id });
      return { ...world, dataRoot: `${world.platform.home}/.local/share/dsh-remote` };
    });
    this.beforeConnect = async definition => {
      await config.beforeConnect?.(definition);
      // Download failures allocate no runtime and must remain retryable, like other preconnect preparation.
      if (!connector && typeof bootstrap === 'function') prepared = await bootstrap();
    };
    ctx.effect(() => async () => {
      this.closed = true;
      const results = await Promise.allSettled([...this.opening.values()].map(async pending => {
        let world: OpenWorld;
        try { world = await pending; } catch { return; } // Failed setup owns its own cleanup.
        await world.ctx.fiber.dispose();
      }));
      const errors = results.filter(result => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'World cleanup failed');
    });
    this.packagedRipgrep = config.packagedRipgrep;
  }
  private packagedRipgrep: string;

  private assertOpen(): void {
    if (this.closed) throw new RemoteError('WORLD_CLOSED', 'World service is disposed');
  }
  private same(left: WorldDefinition, right: WorldDefinition): void {
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new RemoteError('WORLD_MISMATCH', 'World definition changed');
  }
  private async open(input: WorldDefinition): Promise<OpenWorld> {
    this.assertOpen();
    const definition = worldDefinition(input);
    let pending = this.opening.get(definition.id);
    if (!pending) {
      pending = (async () => {
        try { await Promise.resolve().then(() => this.beforeConnect?.(definition)); }
        catch (error) {
          // No runtime allocation was attempted; a corrected source may retry.
          this.opening.delete(definition.id);
          throw error;
        }
        this.assertOpen();
        const connection = await this.connect(definition);
        const owner = new Context();
        let mounted = false;
        try {
          this.assertOpen();
          const info = connection.client.info;
          if (info.world !== definition.id || info.cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Negotiated World or canonical cwd differs from the binding');
          await owner.plugin(worldPlugin(connection.client, () => connection.close(), connection.dataRoot)); mounted = true;
          await owner.plugin(SshFileSystem, { textMaxBytes: 33554432, diffBasisMaxBytes: 1048576 });
          await owner.plugin(SshSubprocess, { executables: { [this.packagedRipgrep]: connection.ripgrep } });
          this.assertOpen();
          const world = { definition, ctx: owner };
          this.ready.set(definition.id, world);
          return world;
        } catch (error) {
          try { await owner.fiber.dispose(); if (!mounted) await connection.close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'World setup failed with unconfirmed cleanup'); }
          throw error;
        }
      })();
      // A failed/runtime-lost World is never silently replaced in this owner lifetime.
      this.opening.set(definition.id, pending);
    }
    const world = await pending;
    this.assertOpen(); this.same(definition, world.definition);
    this.available(definition, definition.cwd);
    return world;
  }

  /** Application selection before normal DSH create. Failure never changes an existing binding. */
  async bind(sessionId: string, input: WorldDefinition): Promise<WorldDefinition> {
    const definition = worldDefinition(input);
    this.bindings.assertCompatible(sessionId, definition);
    await this.open(definition);
    this.bindings.bind(sessionId, definition);
    return definition;
  }

  /** Concrete providers for application-owned workspace selection, before a Session exists. */
  async prepareWorld(input: WorldDefinition): Promise<Context> {
    return (await this.open(input)).ctx;
  }

  /** Application setup before normal DSH resume. Starts a new helper after application restart. */
  async prepare(sessionId: string): Promise<WorldDefinition> {
    const definition = this.bindings.get(sessionId);
    if (!definition) throw new RemoteError('WORLD_REQUIRED', 'Session has no saved World binding');
    await this.open(definition);
    const current = this.bindings.get(sessionId);
    if (!current) throw new RemoteError('WORLD_REQUIRED', 'Session binding disappeared during setup');
    this.same(definition, current);
    return current;
  }

  /** Synchronous access after admission, with the same durable identity and availability checks. */
  forSession(sessionId: string): Context {
    const saved = this.bindings.get(sessionId);
    if (!saved) throw new RemoteError('WORLD_REQUIRED', 'Session has no saved World binding');
    return this.available(saved, saved.cwd);
  }

  private available(definition: WorldDefinition, cwd: string | undefined): Context {
    this.assertOpen();
    const world = this.ready.get(definition.id);
    if (!world) throw new RemoteError('WORLD_NOT_READY', 'Prepare the saved World before publishing the Agent');
    this.same(definition, world.definition);
    if (cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Session cwd differs from its bound World');
    if (world.ctx.remoteWorld.client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Bound World is unavailable');
    return world.ctx;
  }

  /** A live child can inherit identity, but only session-start can authorize a new durable row. */
  inherited(agent: Agent): WorldDefinition | undefined {
    const header = agent.session.header;
    if (header.origin !== 'subagent' || !header.parentSession) return undefined;
    const parent = this.bindings.get(header.parentSession);
    if (!parent) throw new RemoteError('WORLD_REQUIRED', 'Parent Session has no saved World binding');
    this.available(parent, header.cwd);
    return parent;
  }

  adopt(agent: Agent): void {
    const definition = this.bindings.get(agent.session.header.id);
    if (!definition) throw new RemoteError('WORLD_REQUIRED', 'Session has no saved World binding');
    const inherited = this.inherited(agent);
    if (inherited) this.same(inherited, definition);
    this.available(definition, agent.session.header.cwd);
    this.live.set(agent, definition);
  }
  forget(agent: Agent): void { this.live.delete(agent); }

  forAgent(agent: Agent | undefined): Context {
    if (!agent) throw new RemoteError('WORLD_REQUIRED', 'World execution requires an Agent');
    const bound = this.live.get(agent);
    const saved = this.bindings.get(agent.session.header.id);
    if (!bound || !saved) throw new RemoteError('WORLD_REQUIRED', 'Agent has no committed live World binding');
    this.same(bound, saved);
    return this.available(saved, agent.session.header.cwd);
  }
}

/** Explicit resolver injection for native acceptance; the ordinary plugin always uses system SSH. */
export function executionWorldsPlugin(connector: WorldConnector): new (ctx: Context, config: Config) => ExecutionWorlds {
  return class extends ExecutionWorlds {
    constructor(ctx: Context, config: Config) { super(ctx, config, connector); }
  };
}
