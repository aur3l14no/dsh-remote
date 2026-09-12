import type { Context } from '@deepseek-ai/cordis';
import type { ChildEnvironmentRequest, ChildEnvironment } from '@deepseek-ai/dsh-subagent';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import type {} from '../../../world/execution-world/src/worlds.ts';
import type {} from './registry.ts';

export const inject = ['executionWorlds', 'worldPortableWorkspaces', 'sessionPersistence', 'sessions', 'agents'];

/** Native child ownership stays intact; only its execution composition changes. */
export function apply(ctx: Context): void {
  ctx.provide('childExecutionEnvironment', { async prepare(request: ChildEnvironmentRequest): Promise<ChildEnvironment> {
    const { parent, sessionId, operation, selection, signal } = request;
    const worlds = ctx.executionWorlds;
    const registry = ctx.worldPortableWorkspaces;
    worlds.forAgent(parent);
    signal.throwIfAborted();
    if (operation === 'resume') {
      if (selection !== undefined) throw new RemoteError('WORLD_MISMATCH', 'A resumed child cannot select another workspace');
      const header = (await ctx.sessionPersistence.stat(sessionId, { signal }))?.header;
      if (!header || header.origin !== 'subagent' || header.parentSession !== parent.id) {
        throw new RemoteError('WORLD_MISMATCH', 'Child does not belong to this parent');
      }
      const workspace = await registry.contextForSession(sessionId, signal);
      await registry.validate(workspace.id);
      const saved = await worlds.prepare(sessionId);
      return { validate: child => worlds.adopt(child), cwd: saved.cwd, preset: worlds.bindings.explicitParent(sessionId) === undefined ? undefined : saved.kind === 'local' ? 'standard' : 'remote',
        sandboxMode: saved.kind === 'ssh' ? 'danger-full-access' : undefined };
    }
    if (selection !== undefined && request.seeded) {
      throw new RemoteError('WORLD_MISMATCH', 'Explicit execution selection requires a fresh child context');
    }
    if (worlds.bindings.get(sessionId) || ctx.sessions.get(sessionId) || ctx.agents.get(sessionId)
      || await ctx.sessionPersistence.stat(sessionId, { signal })) {
      throw new RemoteError('WORLD_MISMATCH', 'Child Session identity already exists');
    }
    const inherited = worlds.bindings.get(parent.id)!;
    const workspace = selection === undefined
      ? await registry.contextForSession(parent.id, signal)
      : registry.get(WorkspaceId(selection));
    if (!workspace) throw new RemoteError('PORTABLE_WORKSPACE_NOT_FOUND', 'Select an existing workspace from the environment catalog');
    const definition = selection === undefined ? inherited : registry.definition(workspace.id);
    await registry.validate(workspace.id);
    await worlds.prepareWorkspace(definition);
    signal.throwIfAborted();
    worlds.forAgent(parent);
    // Commit before the native factory discovers instructions, tools or permissions.
    worlds.bindings.bind(sessionId, definition, selection === undefined ? undefined : parent.id);
    return { validate: child => worlds.adopt(child), cwd: definition.cwd, preset: selection === undefined ? undefined : definition.kind === 'local' ? 'standard' : 'remote',
      sandboxMode: definition.kind === 'ssh' ? 'danger-full-access'
        : selection === undefined ? parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session) : undefined };
  } });
}
