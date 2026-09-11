import type { Context } from '@deepseek-ai/cordis';
import SandboxPolicy, { type SandboxPolicyRequest } from '@deepseek-ai/dsh-sandbox-policy';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

/** SSH-account authority; unsupported confinement modes fail instead of becoming hints. */
export default class AccountPolicy extends SandboxPolicy {
  static override inject = ['sessionProjections', 'executionWorlds'];
  constructor(ctx: Context) {
    super(ctx, { mode: (process.env.DSH_PERMISSION_MODE as 'workspace-write' | 'read-only' | 'danger-full-access' | undefined) ?? 'workspace-write' });
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return;
      const session = args[0] as Session;
      const definition = ctx.executionWorlds.bindings.get(session.id) ?? (session.header.origin === 'subagent' && session.header.parentSession ? ctx.executionWorlds.bindings.get(session.header.parentSession) : undefined);
      if (definition?.kind !== 'ssh') return;
      const event = args[1] as SessionEvent;
      if (event.type === 'sandbox/mode' && event.data.mode !== 'danger-full-access') {
        throw new Error('This remote profile uses SSH account permissions; remote sandbox modes are not available');
      }
    }, { global: true });
  }
  override resolve(request: SandboxPolicyRequest = {}) {
    const session = request.session;
    if (!session) return super.resolve(request);
    const definition = this.ctx.executionWorlds.bindings.get(session.id)
      ?? (session.header.origin === 'subagent' && session.header.parentSession ? this.ctx.executionWorlds.bindings.get(session.header.parentSession) : undefined);
    if (!definition) throw new Error('Sandbox policy requires a saved execution World');
    if (definition.kind === 'local') return super.resolve(request);
    const mode = request.mode ?? this.overrideOf(session) ?? 'danger-full-access';
    if (mode !== 'danger-full-access') throw new Error('Saved sandbox mode is unsupported by the remote account profile');
    return { mode, workspaceRoot: definition.cwd, sessionId: session.id };
  }
}
