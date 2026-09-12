import type { Context } from '@deepseek-ai/cordis';
import SandboxPolicy, { type SandboxPolicyRequest } from '@deepseek-ai/dsh-sandbox-policy';

/** Resolve native policy against the bound World; SSH enforcement lives in its approval gate. */
export default class AccountPolicy extends SandboxPolicy {
  static override inject = ['sessionProjections', 'executionWorlds'];
  constructor(ctx: Context) {
    super(ctx, { mode: (process.env.DSH_PERMISSION_MODE as 'workspace-write' | 'read-only' | 'danger-full-access' | undefined) ?? 'workspace-write' });
  }
  override resolve(request: SandboxPolicyRequest = {}) {
    const session = request.session;
    if (!session) return super.resolve(request);
    const definition = this.ctx.executionWorlds.bindings.get(session.id)
      ?? (session.header.origin === 'subagent' && session.header.parentSession ? this.ctx.executionWorlds.bindings.get(session.header.parentSession) : undefined);
    if (!definition) throw new Error('Sandbox policy requires a saved execution World');
    if (definition.kind === 'local') return super.resolve(request);
    const mode = request.mode ?? this.overrideOf(session) ?? this.defaultMode;
    return { mode, workspaceRoot: definition.cwd, sessionId: session.id };
  }
}
