import CallEnvironments, { currentEnvironment } from '../../execution-world/src/call-environment.ts';
import type { Context } from '@deepseek-ai/cordis';
import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash';
import type { TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal';
import type {} from '../../execution-world/src/worlds.ts';

export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections', 'executionWorlds'];
const config: ConstructorParameters<typeof BashTerminalBackend>[1] = {
  backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'],
  rows: 40, cols: 160, scrollbackLines: 10000, scrollbackMaxBytes: 1048576, maxReadBytes: 65536,
  pollIntervalMs: 50, exactProbeAfterMs: 150, idleSilenceMs: 500, handoffGraceMs: 200,
  timeoutMs: 30000, disposeGraceMs: 500,
};

/** Select the concrete provider at creation; reads and cleanup retain its handle. */
export function apply(ctx: Context): void {
  ctx.terminals.registerBackend({ type: config.backendType,
    async spawn(spec: TerminalBackendSpawnSpec) {
      const active = currentEnvironment();
      const call = active?.execution.agent === spec.owner ? active : undefined;
      const owner = call?.owner ?? ctx.executionWorlds.forAgent(spec.owner);
      const cwd = owner.fs.processPath(await owner.fs.resolve(call?.cwd ?? spec.cwd ?? spec.owner.session.header.cwd!, { signal: spec.signal }));
      const backend = new BashTerminalBackend(ctx, config, input => owner.subprocess.spawnTerminal(input), undefined, input => {
        const policy = ctx.sandboxPolicy.resolve({ session: input.owner.session });
        const definition = call?.definition ?? ctx.executionWorlds.bindings.get(input.owner.id)!;
        return definition.kind === 'ssh' ? { ...policy, mode: 'danger-full-access' } : policy;
      });
      const session = await backend.spawn({ ...spec, cwd });
      // Native API callers also create terminals without a terminal_open tool result.
      (ctx.get('toolEnvironment') as CallEnvironments | undefined)?.remember(spec.owner, 'terminal', spec.sessionId, {
        owner, definition: call?.definition ?? ctx.executionWorlds.bindings.get(spec.owner.id)!, cwd, explicit: call?.explicit ?? false,
      });
      return session;
    },
  });
}
