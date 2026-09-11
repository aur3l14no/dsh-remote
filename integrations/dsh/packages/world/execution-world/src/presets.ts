import AgentPresets from '@deepseek-ai/dsh-agent-presets';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';

/** Keep native standing mounts and their shared scope state; gate only user selection. */
export default class WorkspacePresets extends AgentPresets {
  static override inject = [...AgentPresets.inject, 'apiSessionAdmission'];
  override async select(agent: Agent, presetId: string): Promise<string> {
    this.ctx.apiSessionAdmission.preset?.(agent.session.header.id, presetId);
    return super.select(agent, presetId);
  }
}
