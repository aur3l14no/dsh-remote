import { currentEnvironment, operationOf } from '../../execution-world/src/call-environment.ts';
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
    const binding = exec.agent && ctx.executionWorlds.bindings.get(exec.agent.session.header.id);
    if (facts.kind === 'local' && binding?.worldId === facts.world) return next();
    if (!exec.agent) throw new RemoteError('WORLD_MISMATCH', 'Tool approval requires a bound Agent');
    exec.signal?.throwIfAborted();
    const session = exec.agent.session;
    const mode = ctx.sandboxPolicy.resolve({ session }).mode;
    const operation = operationOf(ctx.tools.get(exec.name, exec.agent));
    if (mode === 'danger-full-access' || operation?.access === 'read') return next();
    const permissionSeq = session.seq;
    const owner = currentEnvironment()!.owner;
    const args = exec.arguments as Record<string, unknown>;
    let reason: string;
    const path = operation?.path ? args[operation.path] : undefined;
    if (operation?.access === 'write' && typeof path === 'string') {
      const target = await owner.fs.resolve(path, { cwd: facts.cwd, signal: exec.signal });
      const bound = binding!;
      const root = await owner.fs.resolve(bound.worldId === facts.world ? bound.cwd : facts.cwd, { signal: exec.signal });
      if (session.snapshotEvents().slice(permissionSeq).some(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))) {
        throw new RemoteError('APPROVAL_REQUIRED', '权限已变更，请重新执行此文件操作。');
      }
      const contained = bound.worldId === facts.world && owner.fs.contains(root, target);
      if (facts.kind === 'ssh' && mode === 'workspace-write' && contained && owner.remoteWorld.client.info.capabilities.includes('fs.rooted-publish')) {
        exec.signal?.throwIfAborted();
        return fileAuthorization.run({ client: owner.remoteWorld.client, root: bound.cwd }, next);
      }
      const action = exec.name === 'write' ? '写入' : '修改';
      reason = bound.worldId !== facts.world
        ? `此操作将写入另一个执行环境「${facts.world}」的文件 ${target.displayPath}。当前会话工作区为「${bound.worldId}」的 ${bound.cwd}。是否允许？`
        : mode === 'read-only'
        ? `当前是只读模式。是否允许在「${facts.world}」${action}文件 ${target.displayPath}？`
        : contained
          ? `远端组件需要更新才能安全验证工作区内写入。是否允许本次${action} ${target.displayPath}？`
          : `此文件位于工作区（${bound.cwd}）之外。是否允许在「${facts.world}」${action} ${target.displayPath}？`;
    } else {
      reason = exec.name === 'bash'
        ? `是否允许在「${facts.world}」运行此命令？工作目录：${facts.cwd}。命令可能修改工作区外的文件。`
        : `是否允许在「${facts.world}」执行 ${exec.name}？工作目录：${facts.cwd}。`;
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
      if (outcome !== 'allowed-once') throw new RemoteError('APPROVAL_REQUIRED', `Tool call was not authorized (${outcome})`);
      return next();
    } finally {
      dispose();
    }
  });
}
