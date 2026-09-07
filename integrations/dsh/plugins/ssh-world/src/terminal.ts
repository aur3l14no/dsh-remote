import { Readable } from 'node:stream';
import type { SubprocessTerminalHandle, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess';
import { RemoteError, object } from '../../../../../runtime/client/src/index.ts';
import type { Client, Params, RemoteProcess } from '../../../../../runtime/client/src/index.ts';
import { outcome } from './subprocess.ts';

/** The pinned DSH seam has no resize method; trusted clients may use this extension. */
export class SshTerminal implements SubprocessTerminalHandle {
  readonly pid: number;
  readonly output: Readable;
  readonly done: SubprocessTerminalHandle['done'];
  private readonly stopping = new AbortController();
  private readonly reading = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private cleanup?: Promise<void>;
  private readonly drained: Promise<void>;
  private exited = false;

  constructor(private readonly client: Client, private readonly process: RemoteProcess, released: () => void) {
    this.pid = process.pid;
    this.done = process.exited.then(state => { this.exited = true; return outcome(state); });
    this.output = Readable.from(process.raw(0, this.reading.signal), { objectMode: false, highWaterMark: 32768 });
    // Output failure remains visible even when a caller only awaits root exit.
    this.output.on('error', () => {});
    this.done.catch(error => this.output.destroy(error));
    this.drained = new Promise<void>(resolve => { this.output.once('end', resolve); this.output.once('close', resolve); });
    void this.drained.then(async () => {
      if (!this.output.readableEnded) await this.terminate();
      await process.release(); released();
    }).catch(() => {}); // Owner disposal reports cleanup failures; never invent successful cleanup.
  }

  private operation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping.signal.aborted || this.exited) return Promise.reject(new RemoteError('CLOSED', 'Terminal is exiting or closed'));
    const pending = run(this.stopping.signal);
    this.operations.add(pending);
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
    return pending;
  }

  private request(method: string, params: Params = {}): Promise<unknown> {
    return this.operation(signal => this.client.requestWhenReady(method, { process: this.process.id, ...params }, signal));
  }

  write(data: string): Promise<void> {
    return this.operation(signal => this.process.write(Buffer.from(data), signal));
  }

  async inspectForeground() {
    if (this.exited || this.stopping.signal.aborted) return undefined;
    let result;
    try { result = object(await this.request('pty.foreground')); }
    catch (error) {
      // The PTY can lose its controlling session before the status poll observes root exit.
      if (this.exited) return undefined;
      if (error instanceof RemoteError && ['IO_ERROR', 'NOT_FOUND'].includes(error.code)) {
        const state = object(await this.request('process.status'));
        if (state.rootExit !== null) return undefined;
      }
      throw error;
    }
    if (!Number.isSafeInteger(result.group) || (result.group as number) < 0 || result.inputWaiting !== 'unknown') throw new RemoteError('PROTOCOL_ERROR', 'Invalid foreground observation');
    if (result.group === 0) return undefined;
    return { processGroupId: result.group as number, inputWaiting: false };
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'].includes(signal)) throw new RemoteError('INVALID_ARGUMENT', 'Unsupported terminal signal');
    const result = object(await this.request('process.signal', { signal: signal.slice(3), target: 'foreground' }));
    if (result.signalSent !== true || !Number.isSafeInteger(result.group) || (result.group as number) <= 0) throw new RemoteError('PROTOCOL_ERROR', 'Signal delivery was not confirmed');
    return result.group as number;
  }

  async resize(rows: number, cols: number): Promise<void> {
    if (![rows, cols].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) throw new RemoteError('INVALID_ARGUMENT', 'Invalid terminal dimensions');
    await this.request('pty.resize', { rows, cols });
  }

  terminate(): Promise<void> {
    this.cleanup ??= this.stop();
    return this.cleanup;
  }

  private async stop(): Promise<void> {
    this.stopping.abort(); // Reject new work and cancel blocked input before awaiting cleanup.
    const stop = this.process.terminate();
    void stop.catch(() => {});
    await Promise.allSettled([...this.operations]);
    await stop;
    await this.process.quiescent;
  }

  /** Owner teardown explicitly abandons its unread bytes; ordinary terminate preserves them. */
  async dispose(): Promise<void> {
    await this.terminate();
    if (this.output.readableFlowing === true) await this.drained;
    else if (!this.output.readableEnded) {
      this.reading.abort();
      this.output.destroy(new RemoteError('CANCELLED', 'Owner abandoned unread terminal output'));
      await this.drained;
    }
    await this.process.release();
  }
}
