import AgentPresets from '@deepseek-ai/dsh-agent-presets';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';

/** Keep native standing mounts and their shared scope state; gate only user selection. */
export default class WorkspacePresets extends AgentPresets {
  static override inject = [...AgentPresets.inject, 'apiSessionAdmission'];
  // Parameter names are part of Typert's generated wire contract.
  override async select(agent: Agent, agentPreset: string): Promise<string> {
    this.ctx.apiSessionAdmission.preset?.(agent.session.header.id, agentPreset);
    return super.select(agent, agentPreset);
  }
}
