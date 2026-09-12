import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { fileAuthorization } from './file-authorization.ts';
import { executionWorldContext } from '../../execution-world/src/routing.ts';

export const name = 'ssh-world-approval';
export const inject = ['executionWorlds', 'tools', 'sandboxPolicy', 'approval'];

/** A tool-call authorization boundary, not an operating-system sandbox. */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next) => {
    const facts = executionWorldContext(ctx, exec);
    if (facts.kind !== 'ssh' || !exec.agent) throw new RemoteError('WORLD_MISMATCH', 'SSH approval requires a bound SSH Agent');
    exec.signal?.throwIfAborted();
    const session = exec.agent.session;
    const mode = ctx.sandboxPolicy.resolve({ session }).mode;
    if (mode === 'danger-full-access' || exec.name === 'read') return next();
    const permissionSeq = session.seq;
    const owner = ctx.executionWorlds.forAgent(exec.agent);
    const args = exec.arguments as Record<string, unknown>;
    let reason: string;
    if ((exec.name === 'write' || exec.name === 'edit') && typeof args.file_path === 'string') {
      const target = await owner.fs.resolve(args.file_path, { cwd: facts.cwd, signal: exec.signal });
      const root = await owner.fs.resolve(facts.cwd, { signal: exec.signal });
      if (session.snapshotEvents().slice(permissionSeq).some(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))) {
        throw new RemoteError('APPROVAL_REQUIRED', '权限已变更，请重新执行此文件操作。');
      }
      const contained = owner.fs.contains(root, target);
      if (mode === 'workspace-write' && contained && owner.remoteWorld.client.info.capabilities.includes('fs.rooted-publish')) {
        exec.signal?.throwIfAborted();
        return fileAuthorization.run({ client: owner.remoteWorld.client, root: facts.cwd }, next);
      }
      const action = exec.name === 'write' ? '写入' : '修改';
      reason = mode === 'read-only'
        ? `当前是只读模式。是否允许在「${facts.world}」${action}文件 ${target.displayPath}？`
        : contained
          ? `远端组件需要更新才能安全验证工作区内写入。是否允许本次${action} ${target.displayPath}？`
          : `此文件位于工作区（${facts.cwd}）之外。是否允许在「${facts.world}」${action} ${target.displayPath}？`;
    } else {
      reason = exec.name === 'bash'
        ? `是否允许在「${facts.world}」运行此命令？工作目录：${facts.cwd}。命令可能修改工作区外的文件。`
        : `是否允许在「${facts.world}」执行 ${exec.name}？此操作使用远端账户权限。`;
    }

    const changed = new AbortController();
    const dispose = ctx.on('session/event', (subject, event) => {
      if (subject.id === session.id && ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) {
        changed.abort(new Error('Permission changed while approval was pending; retry the tool call'));
      }
    }, { global: true });
    const signal = exec.signal ? AbortSignal.any([exec.signal, changed.signal]) : changed.signal;
    try {
      const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name,
        reason,
        signal });
      signal.throwIfAborted();
      if (outcome !== 'allowed-once') throw new RemoteError('APPROVAL_REQUIRED', `SSH tool call was not authorized (${outcome})`);
      return next();
    } finally {
      dispose();
    }
  });
}
