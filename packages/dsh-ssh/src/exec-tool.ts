import type { Context } from '@deepseek-ai/cordis';

/** Small foreground argv consumer. Shell syntax requires explicitly executing a shell. */
export function applyExecTool(ctx: Context): void {
  ctx.tools.register({
    name: 'exec', description: 'Execute argv in this Agent’s remote World. Foreground only; 30 second budget and bounded output. To use shell syntax, explicitly invoke a shell.',
    parameters: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 128 } }, required: ['argv'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: value => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input, exec) {
      const { argv } = input as { argv: string[] };
      if (!exec.agent || exec.agent !== ctx.agent) throw new Error('exec requires its bound Agent');
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(30000)]);
      const child = ctx.subprocess.spawn({ argv, cwd: exec.agent.session.header.cwd!, signal, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } });
      const outcome = await child.done;
      await child.waitForExit();
      return { ...outcome, timedOut: signal.aborted && !exec.signal.aborted,
        stdout: child.collected.stdout!.readFrom(0), stderr: child.collected.stderr!.readFrom(0) };
    },
  });
}
