import type { Context } from '@deepseek-ai/cordis';
import SandboxPolicy, { type SandboxPolicyRequest } from '@deepseek-ai/dsh-sandbox-policy';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** SSH-account authority; unsupported confinement modes fail instead of becoming hints. */
export default class AccountPolicy extends SandboxPolicy {
  constructor(ctx: Context) {
    super(ctx, { mode: 'danger-full-access', workspaceRoot: '/' });
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return;
      const event = args[1] as SessionEvent;
      if (event.type === 'sandbox/mode' && event.data.mode !== 'danger-full-access') {
        throw new Error('This remote profile uses SSH account permissions; remote sandbox modes are not available');
      }
    }, { global: true });
  }
  override resolve(request: SandboxPolicyRequest = {}) {
    const policy = super.resolve(request);
    if (policy.mode !== 'danger-full-access') throw new Error('Saved sandbox mode is unsupported by the remote account profile');
    return policy;
  }
}
