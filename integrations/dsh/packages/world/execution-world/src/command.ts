import type { Context } from '@deepseek-ai/cordis';

/** Bounded argv execution through a selected provider; never a host-shell fallback. */
export async function worldCommand(owner: Context, cwd: string, argv: string[], signal: AbortSignal, timeoutMs = 10000): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const executable = await owner.subprocess.resolveExecutable(argv[0]!, {}, deadline);
  deadline.throwIfAborted();
  const process = owner.subprocess.spawn({ argv: [executable, ...argv.slice(1)], cwd, env: { LC_ALL: 'C' },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 8192 } },
    graceMs: 1000, signal: deadline });
  try {
    const outcome = await process.done;
    deadline.throwIfAborted();
    const stdout = process.collected.stdout!.readFrom(0);
    if (outcome.exitCode !== 0) throw new Error(`${argv[0]} exited ${outcome.exitCode ?? outcome.signal}: ${process.collected.stderr!.readFrom(0).text}`);
    if (stdout.lossy) throw new Error(`${argv[0]} output exceeded the probe limit`);
    return stdout.text.trim();
  } finally {
    process.terminate();
    if (!await process.waitForExit(AbortSignal.timeout(5000))) throw new Error('Probe process cleanup could not be confirmed');
  }
}
