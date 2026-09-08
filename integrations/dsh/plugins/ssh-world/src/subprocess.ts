import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec, SubprocessOutputMode, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess';
import { Readable, Writable } from 'node:stream';
import { RemoteProcess, RemoteError } from '../../../../../runtime/client/src/index.ts';
import type { OutputSpec } from '../../../../../runtime/client/src/index.ts';
import './world.ts';
import { SshTerminal } from './terminal.ts';

export interface Config {
  /** Exact packaged executable identity -> target-native deployed executable. */
  executables: Record<string, string>;
}

function output(mode: SubprocessOutputMode): OutputSpec {
  return typeof mode === 'string' ? { mode: 'raw', maxBytes: 65536 }
    : { mode: 'collect', maxBytes: mode.maxBytes, ...(mode.spill ? { spillBytes: mode.spill.maxBytes } : {}) };
}
export function outcome(state: Awaited<RemoteProcess['done']>): SubprocessOutcome {
  if (!state.rootExit) throw new RemoteError('EXIT_UNOBSERVED', 'Root exit is not observed');
  const signal = state.rootExit.signal === null ? null : state.rootExit.signalName;
  if (state.rootExit.signal !== null && !signal) throw new RemoteError('UNSUPPORTED_SIGNAL', 'Unknown target exit signal');
  return { exitCode: state.rootExit.code, signal: signal as NodeJS.Signals | null };
}

/** Remote-only subprocess provider, with per-provider ownership in a shared runtime. */
export default class SshSubprocess extends SubprocessRuntime {
  static inject = ['remoteWorld'];
  private executables: Map<string, string>;
  private owned = new Set<Promise<RemoteProcess>>();
  private terminals = new Set<Promise<SshTerminal>>();
  private disposed = false;

  constructor(ctx: Context, config: Config) {
    super(ctx);
    if (!ctx.remoteWorld.client.info.capabilities.includes('process.exit-signal-name')) throw new RemoteError('UNSUPPORTED', 'Target signal-name observations are required');
    this.executables = new Map(Object.entries(config.executables));
    for (const [source, target] of this.executables) if (!source.startsWith('/') || !target.startsWith('/')) throw new Error('Managed executables require absolute identities');
    ctx.effect(() => ctx.remoteWorld.registerOwner(async () => {
      this.disposed = true;
      const results = await Promise.allSettled([...this.owned].map(async pending => {
        const process = await pending;
        await process.terminate(); await process.release();
      }).concat([...this.terminals].map(async pending => { await (await pending).dispose(); })));
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'Remote subprocess owner cleanup failed');
    }));
  }

  async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new RemoteError('OWNER_CLOSED', 'Subprocess owner is disposed');
    const client = this.ctx.remoteWorld.client;
    return (await client.requestWhenReady<{ path: string }>('process.resolveExecutable', { command: this.executables.get(command) ?? command, cwd: client.info.cwd, ...(env ? { env: { ...env } } : {}) }, signal)).path;
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const client = this.ctx.remoteWorld.client;
    if (this.disposed) throw new RemoteError('OWNER_CLOSED', 'Subprocess owner is disposed');
    if (!spec.cwd.startsWith('/')) throw new Error('An absolute target cwd is required');
    if (!Number.isInteger(spec.graceMs) || spec.graceMs < 1 || spec.graceMs > (client.info.limits.maxGraceMs ?? 30000)) throw new RemoteError('UNSUPPORTED_LIMIT', 'Subprocess grace exceeds helper support');
    for (const mode of [spec.stdio.stdout, spec.stdio.stderr]) {
      if (typeof mode !== 'string' && (mode.maxBytes < 1 || mode.maxBytes > client.info.limits.outputBytesPerStream! || (mode.spill?.maxBytes ?? 0) > client.info.limits.spillBytesPerStream!)) throw new RemoteError('UNSUPPORTED_LIMIT', 'Requested output budget exceeds helper support');
    }
    if (spec.signal?.aborted) throw new RemoteError('CANCELLED', 'Spawn aborted before allocation');
    const pending = RemoteProcess.spawn(client, {
      argv: [this.executables.get(spec.argv[0]!) ?? spec.argv[0]!, ...spec.argv.slice(1)], cwd: spec.cwd,
      stdin: spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', stdout: output(spec.stdio.stdout), stderr: output(spec.stdio.stderr),
      graceMs: spec.graceMs, drainMs: spec.graceMs,
      env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value]) => [key, value ?? null])),
    });
    this.owned.add(pending);
    void pending.catch(error => {
      // Unknown/expired allocation outcomes stay owned and make disposal report unconfirmed cleanup.
      if (error instanceof RemoteError && ['NOT_FOUND', 'NOT_DIRECTORY', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'RESOURCE_LIMIT', 'UNSUPPORTED', 'CLIENT_RESOURCE_LIMIT', 'WORLD_NOT_READY'].includes(error.code)) this.owned.delete(pending);
    });
    let process: RemoteProcess | undefined;
    let terminate = false;
    const abort = () => { terminate = true; if (process) void process.terminate().catch(() => {}); };
    spec.signal?.addEventListener('abort', abort, { once: true });
    const ready = pending.then(async allocated => {
      process = allocated;
      if (terminate || this.disposed) await process.terminate();
      return process;
    });
    ready.catch(() => {});
    const rawFinished: Promise<void>[] = [];
    const raw = (index: number): Readable => {
      const end = Promise.withResolvers<void>();
      rawFinished.push(end.promise);
      return Readable.from((async function* () {
        try { yield* (await ready).raw(index); }
        finally { end.resolve(); }
      })(), { objectMode: false, highWaterMark: 32768 });
    };
    const stdout = spec.stdio.stdout === 'pipe' ? raw(0) : undefined;
    const stderr = spec.stdio.stderr === 'pipe' ? raw(1) : undefined;
    const inherited: Promise<void>[] = [];
    for (const [index, mode, destination] of [[0, spec.stdio.stdout, globalThis.process.stdout], [1, spec.stdio.stderr, globalThis.process.stderr]] as const) {
      if (mode === 'inherit') inherited.push((async () => {
        for await (const chunk of (await ready).raw(index)) await new Promise<void>((resolve, reject) => destination.write(chunk, error => error ? reject(error) : resolve()));
      })());
    }
    const stdin = spec.stdio.stdin === 'pipe' ? new Writable({ highWaterMark: 32768,
      write(chunk, _encoding, callback) { void ready.then(p => p.write(chunk)).then(() => callback(), callback); },
      final(callback) { void ready.then(p => p.closeStdin()).then(() => callback(), callback); },
    }) : undefined;
    const finiteBytes = typeof spec.stdio.stdin === 'object' ? Buffer.from(spec.stdio.stdin.data) : undefined;
    const finite = finiteBytes ? (async () => {
      const p = await ready;
      const bytes = finiteBytes;
      for (let i = 0; i < bytes.length; i += 32768) await p.write(bytes.subarray(i, i + 32768));
      await p.closeStdin();
    })() : Promise.resolve();
    // DSH batch input is best-effort; actual exit/output still determines the outcome.
    const done = ready.then(async p => { await finite.catch(() => {}); const state = await p.done; await Promise.all(inherited); return outcome(state); });
    for (const stream of [stdin, stdout, stderr]) stream?.on('error', () => { /* done reports infrastructure failure even when callers only await the outcome. */ });
    done.catch(error => { stdin?.destroy(error); stdout?.destroy(error); stderr?.destroy(error); });
    // Collected mirrors remain on the handle after release. Unconsumed raw streams keep their allocation until disposal.
    void ready.then(async p => {
      await p.quiescent;
      await done.catch(() => {});
      await Promise.all(rawFinished);
      await p.release();
      this.owned.delete(pending);
    }).catch(() => {}); // A failed World keeps cleanup unconfirmed; owner disposal reports it.
    const cleanupListener = () => spec.signal?.removeEventListener('abort', abort);
    void ready.then(p => p.quiescent).then(cleanupListener, cleanupListener);
    const reader = (index: number) => ({ readFrom(offset: number) {
      return process?.collected[index]?.readFrom(offset) ?? { text: '', nextOffset: 0, lossy: false };
    } });
    return { stdin, stdout, stderr,
      collected: { ...(typeof spec.stdio.stdout === 'object' ? { stdout: reader(0) } : {}), ...(typeof spec.stdio.stderr === 'object' ? { stderr: reader(1) } : {}) },
      done, terminate: abort,
      async waitForExit(signal) {
        if (signal?.aborted) return false;
        const wait = ready.then(p => p.quiescent).then(() => true);
        if (!signal) return wait;
        let aborted!: () => void;
        try { return await Promise.race([wait, new Promise<boolean>(resolve => { aborted = () => resolve(false); signal.addEventListener('abort', aborted, { once: true }); })]); }
        finally { signal.removeEventListener('abort', aborted); }
      },
    };
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SshTerminal> {
    const client = this.ctx.remoteWorld.client;
    if (this.disposed) throw new RemoteError('OWNER_CLOSED', 'Subprocess owner is disposed');
    if (!['process.pty', 'process.signals'].every(cap => client.info.capabilities.includes(cap))) throw new RemoteError('UNSUPPORTED', 'Target lacks required terminal capabilities');
    if (!spec.cwd.startsWith('/') || !spec.argv.length || !spec.argv[0]) throw new RemoteError('INVALID_ARGUMENT', 'Terminal requires argv and absolute target cwd');
    if (![spec.rows, spec.cols].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) throw new RemoteError('INVALID_ARGUMENT', 'Invalid terminal dimensions');
    if (!Number.isInteger(spec.graceMs) || spec.graceMs < 1 || spec.graceMs > (client.info.limits.maxGraceMs ?? 30000)) throw new RemoteError('UNSUPPORTED_LIMIT', 'Terminal grace exceeds helper support');
    if (spec.signal?.aborted) throw new RemoteError('CANCELLED', 'Terminal allocation aborted');
    // Do not abandon an admitted allocation on caller abort. Resolve its replay journal, then clean it.
    const allocated = RemoteProcess.spawn(client, { argv: [this.executables.get(spec.argv[0]) ?? spec.argv[0], ...spec.argv.slice(1)],
      cwd: spec.cwd, mode: 'pty', rows: spec.rows, cols: spec.cols, graceMs: spec.graceMs, drainMs: spec.graceMs, env: spec.env });
    const pending = allocated.then(p => new SshTerminal(client, p, () => this.terminals.delete(pending)));
    this.terminals.add(pending);
    void pending.catch(error => {
      if (error instanceof RemoteError && ['NOT_FOUND', 'NOT_DIRECTORY', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'RESOURCE_LIMIT', 'UNSUPPORTED', 'CLIENT_RESOURCE_LIMIT', 'WORLD_NOT_READY'].includes(error.code)) this.terminals.delete(pending);
    });
    const terminal = await pending;
    if (this.disposed || spec.signal?.aborted) {
      await terminal.dispose(); this.terminals.delete(pending);
      throw new RemoteError('CANCELLED', 'Terminal allocation cancelled and cleaned up');
    }
    return terminal;
  }
}
