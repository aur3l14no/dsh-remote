import type { Context } from '@deepseek-ai/cordis';
import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash';
import type { TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal';
import type {} from '../../ssh-world/src/worlds.ts';

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
      const owner = ctx.executionWorlds.forAgent(spec.owner);
      const cwd = owner.fs.processPath(await owner.fs.resolve(spec.cwd ?? spec.owner.session.header.cwd!, { signal: spec.signal }));
      const backend = new BashTerminalBackend(ctx, config, input => owner.subprocess.spawnTerminal(input));
      return backend.spawn({ ...spec, cwd });
    },
  });
}
