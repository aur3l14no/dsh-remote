import type { Context } from '@deepseek-ai/cordis';
import type { ApiSessionAdmissionRequest } from '@deepseek-ai/dsh-api-session-controller';
import { RemoteError } from '../../../../../runtime/client/src/index.ts';
import type { WorldDefinition } from '../../ssh-world/src/bindings.ts';
import type {} from '../../ssh-world/src/worlds.ts';
import type {} from '../../../experiments/portable_workspace/registry.ts';

export const name = 'remote-session-admission';
export const inject = ['executionWorlds', 'worldPortableWorkspaces', 'sessionPersistence', 'sessions', 'agents'];

/** Source-profile adapter for the patched host. It grants no local workspace fallback. */
export function apply(ctx: Context): void {
  ctx.provide('apiSessionAdmission', { prepare: (request: ApiSessionAdmissionRequest) => prepare(ctx, request) });
}

async function prepare(ctx: Context, request: ApiSessionAdmissionRequest): Promise<void> {
  const worlds = ctx.executionWorlds;
  const registry = ctx.worldPortableWorkspaces;
  const sourceId = request.operation === 'fork' ? request.sourceSessionId : request.sessionId;
  if (!sourceId) throw new RemoteError('WORLD_REQUIRED', 'Fork requires a source Session binding');
  const saved = worlds.bindings.get(sourceId);
  let workspace = request.workspaceId === undefined ? undefined : registry.get(request.workspaceId);
  if (request.workspaceId !== undefined && !workspace) {
    throw new RemoteError('PORTABLE_WORKSPACE_NOT_FOUND', 'Selected portable_workspace is absent');
  }
  if (!workspace && saved) workspace = registry.list().find(row => row.sessionIds.some(id => id === sourceId));
  if (!workspace) throw new RemoteError('WORLD_REQUIRED', 'Select a portable_workspace or restore its saved Session membership');
  const definition = registry.definition(workspace.id);
  if (request.cwd !== definition.cwd) throw new RemoteError('WORLD_MISMATCH', 'Session cwd differs from selected portable_workspace');
  if (saved) same(saved, definition);
  else {
    if (request.operation !== 'create') throw new RemoteError('WORLD_REQUIRED', 'Session has no saved World binding');
    // An unbound historical/live identity must never acquire authority from a new UI selection.
    if (ctx.sessions.get(request.sessionId) || ctx.agents.get(request.sessionId)
      || (request.checkPersistedIdentity && (await ctx.sessionPersistence.list()).some(row => row.header.id === request.sessionId))) {
      throw new RemoteError('WORLD_REQUIRED', 'Existing Session has no saved World binding');
    }
  }
  worlds.bindings.assertCompatible(request.sessionId, definition);
  // Verify current catalog, canonical path and directory before publishing or adopting an Agent.
  await registry.validate(workspace.id);
  if (request.operation === 'create' || request.operation === 'fork') await worlds.bind(request.sessionId, definition);
  else await worlds.prepare(request.sessionId);
}

function same(left: WorldDefinition, right: WorldDefinition): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new RemoteError('WORLD_MISMATCH', 'Session belongs to another World or workspace');
}
