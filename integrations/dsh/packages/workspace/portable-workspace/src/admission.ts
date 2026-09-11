import type {} from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type { Context } from '@deepseek-ai/cordis';
import type { ApiSessionAdmissionRequest } from '@deepseek-ai/dsh-api-session-controller';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { sameWorkspace, type WorkspaceDefinition } from '../../../world/execution-world/src/identity.ts';
import type {} from '../../../world/execution-world/src/worlds.ts';
import type {} from './registry.ts';

export const name = 'remote-session-admission';
export const inject = ['executionWorlds', 'worldPortableWorkspaces', 'sessionPersistence', 'sessions', 'agents'];

/** Source-profile adapter for the patched host. It grants no local workspace fallback. */
export function apply(ctx: Context): void {
  function preset(sessionId: string, requested: string | undefined) {
    const saved = ctx.executionWorlds.bindings.get(sessionId);
    if (!saved) throw new RemoteError('WORLD_REQUIRED', 'Preset selection requires an admitted Session');
    const expected = saved.kind === 'local' ? 'standard' : 'remote';
    if (requested !== undefined && requested !== expected) {
      throw new RemoteError('WORLD_MISMATCH', 'Preset does not belong to the Session execution environment');
    }
    return expected;
  }
  ctx.provide('apiSessionAdmission', { prepare: (request: ApiSessionAdmissionRequest) => prepare(ctx, request), preset });
  ctx.provide('sessionPermissionDefaults', { preset(session, configured) {
    const saved = ctx.executionWorlds.bindings.get(session.id);
    // Children receive their parent's domain before their own binding publication.
    const definition = saved ?? (session.header.origin === 'subagent' && session.header.parentSession ? ctx.executionWorlds.bindings.get(session.header.parentSession) : undefined);
    if (!definition) throw new RemoteError('WORLD_REQUIRED', 'Permission initialization requires a bound execution environment');
    return definition.kind === 'ssh' ? 'danger-full-access' : configured;
  }, validate(session, selected) {
    const definition = ctx.executionWorlds.bindings.get(session.id);
    if (!definition) throw new RemoteError('WORLD_REQUIRED', 'Permission selection requires a bound execution environment');
    if (definition.kind === 'ssh' && selected !== 'danger-full-access') throw new RemoteError('WORLD_MISMATCH', 'SSH Worlds use account permissions; sandbox presets are unavailable');
  } });
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
  if (!workspace && saved) workspace = registry.forSession(sourceId);
  if (!workspace && saved && request.operation === 'resume') workspace = await registry.contextForSession(sourceId);
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

function same(left: WorkspaceDefinition, right: WorkspaceDefinition): void {
  if (!sameWorkspace(left, right)) throw new RemoteError('WORLD_MISMATCH', 'Session belongs to another World or workspace');
}
