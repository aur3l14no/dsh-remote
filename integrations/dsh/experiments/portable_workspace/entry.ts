/** PortableWorkspace entry wiring uses public DSH Agent APIs; no second Agent manager. */
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-query';
import { randomUUID } from 'node:crypto';
import { RemoteError } from '../../../../runtime/client/src/index.ts';
import './registry.ts';

export async function startPortableWorkspaceSession(ctx: Context, portableWorkspaceId: WorkspaceId): Promise<SessionId> {
  await ctx.worldPortableWorkspaces.validate(portableWorkspaceId);
  const definition = ctx.worldPortableWorkspaces.definition(portableWorkspaceId);
  const preset = await ctx.agentPresets.resolve();
  const sessionId = SessionId(`session-${randomUUID()}`);
  await ctx.executionWorlds.bind(sessionId, definition);
  await ctx.agents.create({ sessionId, meta: { cwd: definition.cwd, agentPreset: preset.id },
    agentOptions: ctx.agentDefaultModel.currentSelection(),
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); } });
  await ctx.worldPortableWorkspaces.get(portableWorkspaceId)!.attachSession(sessionId);
  return sessionId;
}

export async function openPortableWorkspaceSession(ctx: Context, portableWorkspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
  const portableWorkspace = ctx.worldPortableWorkspaces.get(portableWorkspaceId);
  if (!portableWorkspace?.sessionIds.includes(sessionId)) throw new RemoteError('PORTABLE_WORKSPACE_NOT_FOUND', 'Session is not attached to this PortableWorkspace');
  await ctx.worldPortableWorkspaces.validateSession(portableWorkspaceId, sessionId);
  await ctx.executionWorlds.prepare(sessionId);
  if (!ctx.agents.get(sessionId)) {
    using observation = await ctx.sessionQuery.observeSession(sessionId);
    const preset = observation.projections?.values.agentPreset;
    if (!preset) throw new RemoteError('WORLD_REQUIRED', 'Saved Session preset is required');
    await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: ctx.agentDefaultModel.currentSelection(),
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset); } });
  }
  return sessionId;
}
