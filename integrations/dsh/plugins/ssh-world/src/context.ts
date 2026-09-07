import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { RemoteError } from '../../../../../runtime/client/src/index.ts';
import './world.ts';

const bindings = new WeakMap<Agent, { world: string; runtime: string; cwd: string }>();

function resolveWorld(ctx: Context, agent: Agent) {
  const world = serviceForAgent(ctx, agent, 'remoteWorld');
  if (!world) throw new RemoteError('WORLD_REQUIRED', 'Agent preset has no Execution World');
  const info = world.client.info;
  if (agent.session.header.cwd !== info.cwd) throw new RemoteError('WORLD_MISMATCH', 'Session cwd differs from the selected World');
  return Object.freeze({ world: info.world, runtime: info.runtime, cwd: info.cwd, helperBuild: info.build,
    platform: info.platform, arch: info.arch, capabilities: Object.freeze([...info.capabilities]), state: world.client.state });
}

/** Read the live World bound through DSH's existing preset and publication events. */
export function worldContextFor(ctx: Context, subject: Agent | ToolExecution) {
  const agent = 'session' in subject ? subject : subject.agent;
  if (!agent) throw new RemoteError('WORLD_REQUIRED', 'Execution World requires an Agent');
  const bound = bindings.get(agent);
  if (!bound) throw new RemoteError('WORLD_REQUIRED', 'Agent has no live World binding');
  const facts = resolveWorld(ctx, agent);
  if (bound.world !== facts.world || bound.runtime !== facts.runtime || bound.cwd !== facts.cwd) throw new RemoteError('WORLD_MISMATCH', 'Agent cannot change its bound World');
  return facts;
}

export const name = 'ssh-world-context';
export const inject = ['remoteWorld', 'tools', 'systemPrompt'];

/** Contribute context and execution checks to a standing preset; register no tools or agents. */
export function apply(ctx: Context): void {
  if (scopeOf(ctx) === undefined) throw new RemoteError('WORLD_REQUIRED', 'World context belongs in a DSH preset');
  const client = ctx.remoteWorld.client;
  // DSH owns creation/rollback and inheritance. This observer records only World identity.
  ctx.on('agent/created', ({ agent }) => {
    const facts = resolveWorld(ctx, agent);
    if (facts.state !== 'ready' || facts.runtime !== client.info.runtime) throw new RemoteError('WORLD_NOT_READY', 'World is unavailable during Agent publication');
    const bound = bindings.get(agent);
    if (bound && bound.runtime !== facts.runtime) throw new RemoteError('WORLD_MISMATCH', 'Agent is already bound to another World');
    bindings.set(agent, facts);
  });
  ctx.on('agent/disposed', ({ agent }) => { bindings.delete(agent); });
  const check = (subject: Agent | ToolExecution) => {
    const facts = worldContextFor(ctx, subject);
    if (facts.runtime !== client.info.runtime || facts.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Selected World is unavailable or changed');
    return facts;
  };
  ctx.tools.guard(exec => {
    try { check(exec); } catch (error) { return String(error); }
    // Upstream tool-fs canonicalizes these requests through local realpath before calling ctx.fs.
    // Report the incompatible consumer path; do not replace the tool runtime to rewrite arguments.
    const args = exec.arguments as { file_path?: unknown } | null;
    if (['read', 'write', 'edit'].includes(exec.name) && typeof args?.file_path === 'string'
        && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(args.file_path)) {
      return 'Pinned DSH tool-fs resolves parent paths locally; this request requires an upstream World-aware fix';
    }
    return undefined;
  });
  ctx.systemPrompt.context({ name: 'execution-world', order: -1000,
    text: context => `Execution World (workspace operations execute here):\n${JSON.stringify(check(context.agent!))}` });
}
