/**
 * World-attributed background-job registry.
 *
 * A by-id tool call (`job_output`, `job_kill`) resolves the execution
 * environment recorded for its resource, and the wrapper refuses a resource
 * that has no record. Producers announce creation through
 * `executionEnvironment.produces`, but upstream producers keep appearing
 * without one: the one-shot background `subagent` job declares nothing, and a
 * refusal there breaks the tool rather than catching a mistake.
 *
 * The registry therefore attributes every job where it is created, while the
 * creating call is still the active environment. A start outside any call
 * (native API) keeps the owner's Session binding, the same fallback the shell
 * terminal backend uses. The official registry stays the implementation — this
 * subclass only observes `start`.
 */
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs';
import { currentEnvironment } from './call-environment.ts';
import type CallEnvironments from './call-environment.ts';
import type {} from './worlds.ts';

export default class WorldJobs extends LocalJobRegistry {
  /**
   * Start the job and record the environment that created it.
   * @param spec - job identity, owner, and synchronous starter.
   * @returns the registry-issued job id.
   */
  override start(spec: JobStart): JobId {
    const id = super.start(spec);
    this.attribute(id, spec.owner);
    return id;
  }

  /** Record the creating call's environment, or the owner's binding outside a call. */
  private attribute(id: JobId, owner: JobStart['owner']): void {
    if (owner === undefined) return;
    const environments = this.ctx.get('toolEnvironment') as CallEnvironments | undefined;
    if (environments === undefined) return;
    const call = currentEnvironment();
    const active = call?.execution.agent === owner ? call : undefined;
    const definition = active?.definition ?? this.ctx.executionWorlds.bindings.get(owner.session.header.id);
    if (definition === undefined) return;
    environments.remember(owner, 'job', id, {
      owner: active?.owner ?? this.ctx.executionWorlds.forAgent(owner),
      definition,
      cwd: active?.cwd ?? definition.cwd,
      explicit: active?.explicit ?? false,
    });
  }
}
