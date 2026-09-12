import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import './worlds.ts';
import type {} from '../../../workspace/portable-workspace/src/registry.ts';

export const name = 'world-tools';
export const inject = ['tools', 'executionWorlds', 'worldPortableWorkspaces'];
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function matchWorld(pattern: string, id: string, name: string): boolean {
  if (!pattern || pattern.length > 128) throw new Error('World pattern must contain 1–128 characters');
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return regex.test(id) || regex.test(name);
}

export function apply(ctx: Context): void {
  const registry = ctx.worldPortableWorkspaces;
  function caller(agent: Agent | undefined): Agent {
    ctx.executionWorlds.forAgent(agent);
    if (!agent) throw new Error('A bound calling Agent is required');
    return agent;
  }
  function leader(agent: Agent | undefined): Agent {
    const parent = caller(agent);
    if (ctx.executionWorlds.bindings.get(parent.id)!.kind !== 'local') throw new Error('Prepare cross-World workspaces from a local Session');
    return parent;
  }
  ctx.tools.register(defineTool({
    name: 'list_worlds', description: 'List configured execution Worlds and existing workspace IDs. Filter IDs or names with * and ?. This does not connect, scan networks, or install anything. Use each returned id as prepare_workspace.world_id. Workspace executionEnvironment values are workspace IDs for subagent.execution_environment, not World IDs.',
    parameters: { pattern: { type: 'string', description: 'World ID/name glob, such as node-*; defaults to *.' } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      caller(exec.agent);
      const targets = registry.executionTargets().filter(world => matchWorld(args.pattern ?? '*', world.id, world.name));
      return json(targets.map(world => ({ ...world, workspaces: registry.list().filter(workspace => registry.world(workspace.id).id === world.id)
        .map(workspace => ({ executionEnvironment: workspace.id, path: workspace.path })) })));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'prepare_workspace', description: 'Prepare a workspace for a native child. Supply an existing absolute path, or omit path to create a private /tmp/dsh-workspace.* directory on an SSH World. SSH preparation can install runtime components. Local Sessions only. Returns executionEnvironment for subagent.execution_environment; never changes your Session binding.',
    parameters: { world_id: { type: 'string', required: true, description: 'Exact World id returned by list_worlds.' }, path: { type: 'string', description: 'Existing absolute directory on the selected World. Omit for a new private SSH scratch directory.' } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      leader(exec.agent);
      const workspace = args.path === undefined ? await registry.createScratchInWorld(args.world_id, exec.signal)
        : await registry.createInWorld(args.world_id, args.path);
      return json({ executionEnvironment: workspace.id, worldId: registry.world(workspace.id).id, path: workspace.path });
    },
  }));
}
