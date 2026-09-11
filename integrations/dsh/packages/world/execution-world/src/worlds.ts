import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { BindingStore } from './bindings.ts';
import { workspaceDefinition, sameWorkspace, type WorkspaceDefinition } from './identity.ts';
import { SshWorldAdapter, type SshAdapterConfig, type WorldConnector } from '../../ssh-world/src/adapter.ts';
import { openLocalWorld } from '../../local-world/src/adapter.ts';
export type { WorldConnection, WorldConnector, BootstrapConfig } from '../../ssh-world/src/adapter.ts';

export interface Config extends SshAdapterConfig {
  /** Native providers supplied by the host composition, never inferred from cwd. */
  local?: Context;
  bindingFile: string;
}
interface OpenWorld { definition: WorkspaceDefinition; ctx: Context }
declare module '@deepseek-ai/cordis' { interface Context { executionWorlds: ExecutionWorlds } }

/** Owns World connections and durable bindings, never Agent creation or Session history. */
export default class ExecutionWorlds extends Service {
  readonly bindings: BindingStore;
  private opening = new Map<string, Promise<OpenWorld>>();
  private ready = new Map<string, OpenWorld>();
  private live = new WeakMap<Agent, WorkspaceDefinition>();
  private closed = false;
  private readonly ssh: SshWorldAdapter;
  private readonly local?: Context;

  constructor(ctx: Context, config: Config, connector?: WorldConnector) {
    super(ctx, 'executionWorlds');
    this.bindings = new BindingStore(config.bindingFile);
    this.local = config.local;
    this.ssh = new SshWorldAdapter(config, connector);
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
  }

  private assertOpen(): void {
    if (this.closed) throw new RemoteError('WORLD_CLOSED', 'World service is disposed');
  }
  private same(left: WorkspaceDefinition, right: WorkspaceDefinition): void {
    if (!sameWorkspace(left, right)) throw new RemoteError('WORLD_MISMATCH', 'World definition changed');
  }
  private async open(input: WorkspaceDefinition): Promise<OpenWorld> {
    this.assertOpen();
    const definition = workspaceDefinition(input);
    let pending = this.opening.get(definition.id);
    if (!pending) {
      pending = (async () => {
        if (definition.kind === 'local') {
          const world = { definition, ctx: openLocalWorld(this.local) };
          this.ready.set(definition.id, world);
          return world;
        }
        try { await this.ssh.prepare(definition); }
        catch (error) {
          // No runtime allocation was attempted; a corrected source may retry.
          this.opening.delete(definition.id);
          throw error;
        }
        this.assertOpen();
        const owner = await this.ssh.open(definition);
        try {
          this.assertOpen();
          const world = { definition, ctx: owner };
          this.ready.set(definition.id, world);
          return world;
        } catch (error) {
          await owner.fiber.dispose();
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
  async bind(sessionId: string, input: WorkspaceDefinition): Promise<WorkspaceDefinition> {
    const definition = workspaceDefinition(input);
    this.bindings.assertCompatible(sessionId, definition);
    await this.open(definition);
    this.bindings.bind(sessionId, definition);
    return definition;
  }

  /** Concrete providers for application-owned workspace selection, before a Session exists. */
  async prepareWorld(input: WorkspaceDefinition): Promise<Context> {
    return (await this.open(input)).ctx;
  }

  /** Application setup before normal DSH resume. Starts a new helper after application restart. */
  async prepare(sessionId: string): Promise<WorkspaceDefinition> {
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

  private available(definition: WorkspaceDefinition, cwd: string | undefined): Context {
    this.assertOpen();
    const world = this.ready.get(definition.id);
    if (!world) throw new RemoteError('WORLD_NOT_READY', 'Prepare the saved World before publishing the Agent');
    this.same(definition, world.definition);
    if (cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Session cwd differs from its bound World');
    if (definition.kind === 'ssh') this.ssh.assertReady(world.ctx);
    return world.ctx;
  }

  /** A live child can inherit identity, but only session-start can authorize a new durable row. */
  inherited(agent: Agent): WorkspaceDefinition | undefined {
    const header = agent.session.header;
    if (header.origin !== 'subagent' || !header.parentSession) return undefined;
    const parent = this.bindings.get(header.parentSession);
    if (!parent) throw new RemoteError('WORLD_REQUIRED', 'Parent Session has no saved World binding');
    const explicitParent = this.bindings.explicitParent(header.id);
    if (explicitParent !== undefined) {
      if (explicitParent !== header.parentSession) throw new RemoteError('WORLD_MISMATCH', 'Explicit child belongs to another parent');
      const own = this.bindings.get(header.id)!;
      this.available(own, header.cwd);
      return own;
    }
    this.available(parent, header.cwd);
    return parent;
  }

  adopt(agent: Agent): void {
    const definition = this.bindings.get(agent.session.header.id);
    if (!definition) throw new RemoteError('WORLD_REQUIRED', 'Session has no saved World binding');
    if (this.bindings.explicitParent(agent.session.header.id) && agent.session.header.origin !== 'subagent') {
      throw new RemoteError('WORLD_MISMATCH', 'Explicit child binding requires child Session metadata');
    }
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
