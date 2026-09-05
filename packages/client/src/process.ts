import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from './client.ts';
import { CollectedStream, rawStream } from './streams.ts';
import { RemoteError, object, protocolError } from './protocol.ts';
import type { Params, ProcessState, Snapshot, Spawned } from './protocol.ts';

export interface OutputSpec { mode: 'raw' | 'collect'; maxBytes: number; spillBytes?: number }
export interface SpawnSpec {
  argv: readonly string[];
  cwd: string;
  mode?: 'pipe' | 'pty';
  stdin?: 'ignore' | 'pipe';
  stdout?: OutputSpec;
  stderr?: OutputSpec;
  env?: Record<string, string | null>;
  graceMs?: number;
  drainMs?: number;
  rows?: number;
  cols?: number;
}

function status(value: unknown, id: string): ProcessState {
  const s = object(value);
  if (s.process !== id || !Number.isSafeInteger(s.pid) || !Number.isSafeInteger(s.revision)
      || typeof s.closed !== 'boolean' || typeof s.cleanupComplete !== 'boolean') throw protocolError('Invalid process observation');
  if (s.rootExit !== null) {
    const exit = object(s.rootExit);
    if (!(exit.code === null || Number.isSafeInteger(exit.code)) || !(exit.signal === null || Number.isSafeInteger(exit.signal))) throw protocolError('Invalid exit observation');
  }
  return s as unknown as ProcessState;
}

export class RemoteProcess {
  readonly id: string;
  readonly pid: number;
  readonly outputs: ReadonlyArray<{ stream: string; mode: 'raw' | 'collect' }>;
  readonly collected: ReadonlyArray<CollectedStream | undefined>;
  readonly done: Promise<ProcessState>;
  /** Root exit alone, independent of output drain and observable-session cleanup. */
  readonly exited: Promise<ProcessState>;
  readonly quiescent: Promise<void>;
  #client: Client;
  #closed = Promise.withResolvers<ProcessState>();
  #exit = Promise.withResolvers<ProcessState>();
  #quiet = Promise.withResolvers<void>();
  #input: Promise<unknown> = Promise.resolve();
  #inputBytes = 0;
  #stop?: Promise<{ accepted: boolean; cleanupComplete: boolean }>;
  #released = false;
  #releasing?: Promise<void>;
  #state?: ProcessState;
  #finalizing = false;
  #onOutput: (value: unknown) => void;
  #onFailure: (error: Error) => void;

  private constructor(client: Client, spawned: Spawned, spec: SpawnSpec) {
    this.#client = client; this.id = spawned.process; this.pid = spawned.pid;
    this.outputs = spawned.outputs;
    this.collected = spawned.outputs.map((o, i) => o.mode === 'collect' ? new CollectedStream(o.stream, (i === 0 ? spec.stdout : spec.stderr)!.maxBytes) : undefined);
    this.done = this.#closed.promise; this.quiescent = this.#quiet.promise; this.exited = this.#exit.promise;
    this.done.catch(() => {}); this.quiescent.catch(() => {}); this.exited.catch(() => {});
    this.#onOutput = value => {
      const id = object(value).stream;
      const mirror = this.collected.find(c => c?.id === id);
      if (mirror) mirror.install(value);
    };
    this.#onFailure = error => { this.#exit.reject(error); this.#closed.reject(error); this.#quiet.reject(error); };
    client.on('stream.data', this.#onOutput);
    client.on('failure', this.#onFailure);
    void this.#monitor();
  }

  static async spawn(client: Client, spec: SpawnSpec): Promise<RemoteProcess> {
    await client.whenReady();
    const spawned = await client.requestWhenReady<Spawned>('process.spawn', spec as unknown as Params);
    if (typeof spawned.process !== 'string' || !Number.isSafeInteger(spawned.pid) || !Array.isArray(spawned.outputs)) throw protocolError('Invalid allocation response');
    return new RemoteProcess(client, spawned, spec);
  }

  async #monitor(): Promise<void> {
    try {
      while (!this.#released) {
        await this.#client.whenReady();
        const s = status(await this.#client.requestWhenReady('process.status', { process: this.id }), this.id);
        this.#state = s;
        if (s.rootExit) this.#exit.resolve(s);
        if (s.closed && !this.#finalizing) {
          this.#finalizing = true;
          // Closed may precede final stream events. Install the complete retained output first.
          void Promise.all(this.collected.map(c => c?.finalize(this.#client))).then(() => this.#closed.resolve(s), error => this.#closed.reject(error));
        }
        if (s.cleanupComplete) this.#quiet.resolve();
        if (s.closed && s.cleanupComplete) return;
        await delay(40);
      }
    } catch (error) { this.#exit.reject(error); this.#closed.reject(error); this.#quiet.reject(error); }
  }

  raw(index: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const output = this.outputs[index];
    if (!output || output.mode !== 'raw') throw new Error('Output is not a raw stream');
    return rawStream(this.#client, output.stream, signal);
  }

  write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.#inputBytes + data.length > 1024 * 1024) return Promise.reject(new RemoteError('CLIENT_RESOURCE_LIMIT', 'Pending input byte budget exhausted'));
    // Copy now so a caller cannot mutate an admitted write's bytes while queued.
    const bytes = Buffer.from(data);
    this.#inputBytes += bytes.length;
    const operation = this.#input.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += this.#client.info.limits.chunkBytes!) {
        await this.#client.whenReady();
        const chunk = bytes.subarray(offset, offset + this.#client.info.limits.chunkBytes!);
        try {
          await this.#client.requestWhenReady('process.write', { process: this.id, data: chunk.toString('base64') }, signal);
        } catch (error) {
          // Earlier chunks definitely completed; the failed chunk retains its own partial/unknown facts.
          throw new RemoteError('INPUT_FAILED', 'Process input did not complete', { completedPrefix: offset,
            cause: error instanceof RemoteError ? { code: error.code, details: error.details ?? null } : null });
        }
      }
    });
    const settled = operation.finally(() => { this.#inputBytes -= bytes.length; });
    this.#input = settled; this.#input.catch(() => {});
    return settled;
  }

  closeStdin(): Promise<void> {
    const operation = this.#input.catch(() => {}).then(async () => {
      await this.#client.whenReady();
      await this.#client.requestWhenReady('process.closeStdin', { process: this.id });
    });
    this.#input = operation; this.#input.catch(() => {});
    return operation;
  }

  terminate(): Promise<{ accepted: boolean; cleanupComplete: boolean }> {
    this.#stop ??= (async () => {
      if (this.#state?.cleanupComplete) return { accepted: true, cleanupComplete: true };
      await this.#client.whenReady();
      return this.#client.requestWhenReady<{ accepted: boolean; cleanupComplete: boolean }>('process.terminate', { process: this.id });
    })();
    return this.#stop;
  }

  release(): Promise<void> {
    this.#releasing ??= this.#release();
    return this.#releasing;
  }

  async #release(): Promise<void> {
    if (this.#released) return;
    // A stream failure must not prevent a confirmed quiescent process from being released.
    await this.quiescent;
    await this.done.catch(() => {});
    await this.#client.whenReady();
    await this.#client.requestWhenReady('process.release', { process: this.id });
    this.#released = true;
    this.#client.off('stream.data', this.#onOutput);
    this.#client.off('failure', this.#onFailure);
  }
}
