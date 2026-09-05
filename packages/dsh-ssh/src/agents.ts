import { Context, symbols } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';
import { RemoteError } from '../../client/src/index.ts';
import type { Client } from '../../client/src/index.ts';
import SshFileSystem from './fs.ts';
import SshSubprocess from './subprocess.ts';
import { worldPlugin } from './world.ts';
import { WorldPool } from './world-pool.ts';
import type { WorldDefinition, WorldIdentity } from './world-pool.ts';
import { applyExecTool } from './exec-tool.ts';
import WorldToolRuntime from './tools.ts';
import WorldSessionPersistence from './persistence.ts';
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';

export interface WorldBinding {
  readonly schema: 1;
  readonly session: string;
  readonly world: WorldIdentity;
  readonly runtime: string;
  readonly helperBuild: string;
  readonly platform: string;
  readonly arch: string;
  readonly capabilities: readonly string[];
}
export interface WorldContext extends WorldBinding { readonly state: Client['state'] }
declare module '@deepseek-ai/dsh-agent' {
  interface CreateAgentOptions { readonly world?: string }
  interface ResumeAgentOptions { readonly world?: string }
}
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'execution-world/bound': WorldBinding;
    'execution-world/handoff': { sourceSession: string; sourceWorld: string };
  }
}

const PROFILE = new Set(['read', 'write', 'edit', 'glob', 'grep', 'exec']);
const serviceIdentity = (service: object): object => (service as { [symbols.original]?: object })[symbols.original] ?? service;
interface ActiveBinding { readonly public: WorldBinding; readonly client: Client; readonly scope: Context; readonly assert: () => void }
export interface Config { readonly worlds: readonly WorldDefinition[] }

function identityEqual(left: WorldIdentity, right: WorldIdentity): boolean {
  return left.id === right.id && left.target === right.target && left.cwd === right.cwd;
}

/** Match by owning Session ID: resume markers and fork-inherited events are not binding authority. */
function storedBinding(session: Session): WorldBinding | undefined {
  let own: WorldBinding | undefined;
  for (const event of session.ownEvents()) {
    if (event.type !== 'execution-world/bound' || event.data.session !== session.id) continue;
    const candidate = event.data;
    if (candidate.schema !== 1 || !candidate.world || typeof candidate.world.id !== 'string' || typeof candidate.world.target !== 'string' || typeof candidate.world.cwd !== 'string') throw new RemoteError('WORLD_BINDING_INVALID', 'Stored World binding is invalid or unsupported');
    if (own && !identityEqual(own.world, candidate.world)) throw new RemoteError('WORLD_BINDING_INVALID', 'Stored Session changes World identity');
    own = candidate;
  }
  return own;
}

/** External replacement for the registry service. The DSH Agent Loop remains unchanged. */
export default class WorldAgentRegistry extends AgentRegistry {
  static inject = ['tools', 'systemPrompt'];
  private pool: WorldPool;
  private bindings = new WeakMap<Agent, ActiveBinding>();

  constructor(ctx: Context, config: Config) {
    super(ctx);
    if (!(ctx.tools instanceof WorldToolRuntime)) throw new Error('SSH Agent composition requires WorldToolRuntime');
    this.pool = new WorldPool(config.worlds);
    // This runs after extensible approval: approval cannot make an unbound or failed World executable.
    ctx.tools.guard(exec => {
      if (!exec.agent) return 'Workspace execution requires a bound Agent';
      try { this.requireBinding(exec.agent).assert(); }
      catch { return 'Agent World is unbound, changed or unavailable'; }
      return undefined;
    });
  }

  /** Read-only metadata for Auto Approval. Never mutate DSH's immutable ToolExecution. */
  contextFor(subject: Agent | ToolExecution): WorldContext {
    const agent = 'session' in subject ? subject : subject.agent;
    if (!agent) throw new RemoteError('WORLD_REQUIRED', 'Approval context requires a bound Agent');
    const binding = this.requireBinding(agent);
    return Object.freeze({ ...binding.public, state: binding.client.state });
  }

  /** Trusted local consumers use this dependency-declaring context, owned by the Agent. */
  scopeFor(agent: Agent): Context {
    const binding = this.requireBinding(agent);
    binding.assert();
    return binding.scope;
  }

  private requireBinding(agent: Agent): ActiveBinding {
    const binding = this.bindings.get(agent);
    if (!binding) throw new RemoteError('WORLD_REQUIRED', 'Agent has no World binding');
    return binding;
  }

  private selection(requested?: string): string | undefined {
    const parent = this.ctx.agent;
    if (!parent) return requested;
    const binding = this.requireBinding(parent);
    binding.assert();
    if (requested !== undefined && requested !== binding.public.world.id) throw new RemoteError('WORLD_HANDOFF_REQUIRED', 'Create a new root Agent for cross-World work');
    return binding.public.world.id;
  }

  override async create(options: CreateAgentOptions): Promise<AgentHandle> {
    this.checkPersistence();
    const id = this.selection(options.world);
    if (!id) throw new RemoteError('WORLD_REQUIRED', 'Choose a World before Agent creation');
    const definition = this.pool.definition(id);
    if (options.meta?.cwd !== undefined && options.meta.cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Session cwd must equal the declared canonical remote cwd');
    if (options.seed?.length && !options.seed.some(event => event.type === 'execution-world/bound')) throw new RemoteError('WORLD_BINDING_INVALID', 'Fork history has no World provenance');
    for (const event of options.seed ?? []) {
      if (event.type === 'execution-world/bound' && (!event.data.world || !identityEqual(event.data.world, definition))) throw new RemoteError('WORLD_HANDOFF_REQUIRED', 'History from another World cannot implicitly seed this Agent');
    }
    return super.create({ ...options, meta: { ...options.meta, cwd: definition.cwd }, setup: this.setupWorld(id, false, options.setup) });
  }

  override async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    this.checkPersistence();
    return super.resume({ ...options, setup: this.setupWorld(this.selection(options.world), true, options.setup) });
  }

  private checkPersistence(): void {
    const persistence = this.ctx.get('sessionPersistence');
    if (!(persistence instanceof WorldSessionPersistence)) throw new RemoteError('WORLD_PERSISTENCE_REQUIRED', 'Required World records need WorldSessionPersistence');
  }

  /** Explicit new-root handoff; copies provenance only, never processes or implicit history. */
  async handoff(source: Agent, options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.ctx.agent || options.seed?.length) throw new RemoteError('WORLD_HANDOFF_REQUIRED', 'Handoff requires a local root owner and a fresh Session');
    const previous = this.contextFor(source);
    return this.create({ ...options, setup: async ctx => {
      ctx.agent!.session.append('execution-world/handoff', { sourceSession: source.id, sourceWorld: previous.world.id });
      return options.setup?.(ctx);
    } });
  }

  /** Also guards configured/direct factory entry, including persistence awaits after setup.commit(). */
  override enter(agent: Agent, owner: Agent | undefined): () => void {
    this.requireBinding(agent).assert();
    return super.enter(agent, owner);
  }

  private setupWorld(selected: string | undefined, resume: boolean, setup?: AgentSetup): AgentSetup {
    return async ctx => {
      const agent = ctx.agent!;
      const saved = storedBinding(agent.session);
      if (resume && !saved) throw new RemoteError('WORLD_BINDING_INVALID', 'Resume requires a persisted World binding');
      const id = selected ?? saved?.world.id;
      if (!id) throw new RemoteError('WORLD_REQUIRED', 'Choose a World before publication');
      const definition = this.pool.definition(id);
      if ((saved && !identityEqual(saved.world, definition)) || agent.session.header.cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Persisted World identity or cwd differs from the deployment declaration');
      const lease = this.pool.acquire(id);
      let disposed = false;
      // Installed before provisioning: rollback owns even a bootstrap that resolves after cancellation.
      ctx.effect(() => async () => { disposed = true; this.bindings.delete(agent); await lease.release(); });
      const connection = await lease.ready;
      if (disposed) throw new RemoteError('OWNER_CLOSED', 'Agent setup was disposed during provisioning');
      const info = connection.client.info;
      const binding: WorldBinding = Object.freeze({ schema: 1, session: agent.id,
        world: Object.freeze({ id, target: definition.target, cwd: definition.cwd }), runtime: info.runtime,
        helperBuild: info.build, platform: info.platform, arch: info.arch, capabilities: Object.freeze([...info.capabilities]) });
      // Same public isolation metadata used by Cordis Loader. Replace only this unpublished Agent's map.
      const isolation = Object.create(ctx[Context.isolate]) as Context[typeof Context.isolate];
      for (const name of ['remoteWorld', 'fs', 'subprocess']) isolation[name] = Symbol(name);
      Object.defineProperty(ctx, Context.isolate, { value: Object.freeze(isolation), writable: false, configurable: false });
      await ctx.plugin(worldPlugin(connection.client, lease.release));
      await ctx.plugin(SshFileSystem, { textMaxBytes: 64 * 1024 * 1024, diffBasisMaxBytes: 1024 * 1024 });
      const packagedRipgrep = await resolveRgPath();
      await ctx.plugin(SshSubprocess, { executables: { [packagedRipgrep]: connection.ripgrep } });
      let assert!: () => void;
      await ctx.plugin({ name: 'ssh-agent-consumers', inject: ['fs', 'subprocess', 'remoteWorld', 'tools', 'systemPrompt'], apply: async (scope: Context) => {
        const fs = serviceIdentity(scope.fs), subprocess = serviceIdentity(scope.subprocess), world = serviceIdentity(scope.remoteWorld);
        assert = () => {
          if (disposed || connection.client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Agent World is unavailable');
          if (serviceIdentity(scope.fs) !== fs || serviceIdentity(scope.subprocess) !== subprocess || serviceIdentity(scope.remoteWorld) !== world || agent.session.header.cwd !== binding.world.cwd) throw new RemoteError('WORLD_MISMATCH', 'Agent provider realm or cwd changed');
        };
        this.bindings.set(agent, { public: binding, client: connection.client, scope, assert });
        (scope.tools as WorldToolRuntime).maskInherited();
        scope.tools.guard(exec => PROFILE.has(exec.name) ? undefined : 'Tool is outside the verified SSH World profile');
        await scope.plugin(FileTools);
        await scope.plugin(SearchTools, { sampleOverCapGlobResults: false });
        await scope.plugin(SessionCheckpointPolicy);
        applyExecTool(scope);
        scope.systemPrompt.context({ name: 'execution-world', order: -1000,
          text: () => `Execution World (workspace operations must remain here; cross-World work requires a new Agent/handoff):\n${JSON.stringify(this.contextFor(agent))}` });
      } });
      agent.session.append('execution-world/bound', binding);
      const commit = await setup?.(ctx);
      return { commit() { commit?.commit(); assert(); } };
    };
  }
}
