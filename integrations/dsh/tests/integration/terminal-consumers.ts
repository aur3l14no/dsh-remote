import type { Context } from '@deepseek-ai/cordis';
import TerminalSessionService from '@deepseek-ai/dsh-terminal';
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash';
import * as TerminalTools from '@deepseek-ai/dsh-tool-terminal';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import * as JobTools from '@deepseek-ai/dsh-tool-jobs';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { RemoteError } from '../../../../runtime/client/src/index.ts';

export interface TerminalConfig { /** Resolved in the World, never on the local PATH. */ shell: string }

/** Acceptance-only application composition of actual DSH consumers; not part of the World plugin. */
export async function applyTerminalConsumers(ctx: Context, config: TerminalConfig): Promise<void> {
  if (!ctx.remoteWorld.client.info.capabilities.includes('process.pty')) throw new RemoteError('UNSUPPORTED', 'Terminal profile requires remote PTY');
  const shell = await ctx.subprocess.resolveExecutable(config.shell);
  const probe = ctx.subprocess.spawn({ argv: [shell, '--noprofile', '--norc', '-c', 'test -n "$BASH_VERSION"'],
    cwd: ctx.remoteWorld.client.info.cwd, graceMs: 500, signal: AbortSignal.timeout(5000),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } });
  const result = await probe.done;
  await probe.waitForExit();
  if (result.exitCode !== 0) throw new RemoteError('UNSUPPORTED', 'Terminal profile requires a working target Bash');
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: ctx.remoteWorld.client.info.cwd });
  await ctx.plugin(TerminalSessionService);
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 });
  await ctx.plugin(TerminalBash, { shellPath: shell, shellDialect: 'bash', pollIntervalMs: 50, exactProbeAfterMs: 150,
    idleSilenceMs: 500, handoffGraceMs: 200, timeoutMs: 30000, disposeGraceMs: 500,
    scrollbackLines: 10000, scrollbackMaxBytes: 1024 * 1024, maxReadBytes: 65536 });
  await ctx.plugin(JobTools, { completionDelivery: 'quiet' });
  await ctx.plugin(TerminalTools, { maxResultBytes: 65536 });
}
