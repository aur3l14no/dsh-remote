import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-workspace-files';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '../../../world/ssh-world/src/worlds.ts';
import type {} from './registry.ts';
import { observe } from '../../../../shared/lifetime.ts';

/** Non-tool reads carry their own Session owner, independent of active UI navigation. */
export const inject = ['executionWorlds', 'worldPortableWorkspaces'];
export function apply(ctx: Context): void {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(new Error('File preview disposed')));
  async function resolve(sessionId: string, signal: AbortSignal) {
    const active = AbortSignal.any([signal, lifetime.signal]);
    active.throwIfAborted();
    const id = SessionId(sessionId);
    const workspace = await observe(ctx.worldPortableWorkspaces.contextForSession(id, active), active);
    const expected = ctx.worldPortableWorkspaces.definition(workspace.id);
    const saved = ctx.executionWorlds.bindings.get(id);
    if (JSON.stringify(expected) !== JSON.stringify(saved)) throw new Error('File preview binding mismatch');
    const definition = await observe(ctx.executionWorlds.prepare(id), active);
    const owner = await observe(ctx.executionWorlds.prepareWorld(definition), active);
    active.throwIfAborted();
    return { fs: owner.fs, workspaceRoot: definition.cwd };
  }
  ctx.provide('workspaceFileEnvironment', { resolve });
  ctx.provide('sessionMediaEnvironment', { async resolve(sessionId, signal) {
    return (await resolve(sessionId, signal)).fs;
  } });
}
