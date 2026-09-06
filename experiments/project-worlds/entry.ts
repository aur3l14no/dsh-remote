/** Project entry wiring uses public DSH Agent APIs; no second Agent manager. */
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-query';
import { randomUUID } from 'node:crypto';
import { RemoteError } from '../../packages/client/src/index.ts';
import './registry.ts';

export async function startProjectSession(ctx: Context, projectId: WorkspaceId): Promise<SessionId> {
  await ctx.worldProjects.validate(projectId);
  const definition = ctx.worldProjects.definition(projectId);
  const preset = await ctx.agentPresets.resolve();
  const sessionId = SessionId(`session-${randomUUID()}`);
  await ctx.executionWorlds.bind(sessionId, definition);
  await ctx.agents.create({ sessionId, meta: { cwd: definition.cwd, agentPreset: preset.id },
    agentOptions: ctx.agentDefaultModel.currentSelection(),
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); } });
  await ctx.worldProjects.get(projectId)!.attachSession(sessionId);
  return sessionId;
}

export async function openProjectSession(ctx: Context, projectId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
  const project = ctx.worldProjects.get(projectId);
  if (!project?.sessionIds.includes(sessionId)) throw new RemoteError('PROJECT_NOT_FOUND', 'Session is not attached to this Project');
  await ctx.worldProjects.validateSession(projectId, sessionId);
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
