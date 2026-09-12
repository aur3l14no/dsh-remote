import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encode, frames, MAX_FRAME } from './framing.ts';
import { object, protocolError, RemoteError } from './protocol.ts';
import type { ClientState, Hello, Json, Params } from './protocol.ts';

export type TransportFactory = (signal: AbortSignal) => Promise<Duplex>;
export interface ClientOptions {
  world: string;
  connect: TransportFactory;
  required?: string[];
  connectTimeoutMs?: number;
}
interface Pending {
  id: number;
  method: string;
  frame: Buffer;
  control: boolean;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  removeAbort(): void;
  cancelWanted: boolean;
  cancelSent: boolean;
}
const controls = new Set(['runtime.ping', 'runtime.cancel', 'runtime.shutdown', 'stream.ack', 'process.terminate', 'process.status']);
// Wire error strings cannot prove that an operation was never admitted locally.
class AdmissionError extends RemoteError {}

/** One live runtime epoch. A factory reconnects only to its existing socket. */
export class Client extends EventEmitter {
  #options: ClientOptions;
  #state: ClientState = 'starting';
  #hello?: Hello;
  #transport?: Duplex;
  #attempt?: AbortController;
  #greeting?: ReturnType<typeof Promise.withResolvers<unknown>>;
  #pending = new Map<number, Pending>();
  #bytes = 0;
  #waiting = 0;
  #sequence = 0;
  #heartbeat?: NodeJS.Timeout;
  #recovering?: Promise<void>;
  #failure?: RemoteError;
  #close?: Promise<void>;

  private constructor(options: ClientOptions) {
    super();
    this.setMaxListeners(128); // At most 16 live processes plus bounded stream/connection waiters.
    if (!options.world || options.world.includes('\0')) throw new Error('An explicit World identity is required');
    if (options.connectTimeoutMs !== undefined && (!Number.isInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1 || options.connectTimeoutMs > 60000)) throw new Error('Invalid connection timeout');
    this.#options = options;
  }

  static async open(options: ClientOptions): Promise<Client> {
    const client = new Client(options);
    try {
      await client.#connect();
      if (!client.#transport || client.#state === 'failed') throw client.#failure ?? new RemoteError('TRANSPORT_CLOSED', 'Transport closed during startup');
      client.#setState('ready');
      client.#startHeartbeat();
      return client;
    } catch (error) {
      client.#fail(error);
      throw error;
    }
  }

  get state(): ClientState { return this.#state; }
  /** Resume credentials deliberately stay out of model/UI-facing context. */
  get info(): Omit<Hello, 'token'> {
    if (!this.#hello) throw new RemoteError('WORLD_NOT_READY', 'Runtime has not negotiated');
    const { token: _token, ...info } = this.#hello;
    return structuredClone(info);
  }

  #setState(state: ClientState): void {
    this.#state = state;
    this.emit('state', state);
  }

  async #connect(remainingMs = 60000): Promise<void> {
    const attempt = new AbortController();
    this.#attempt = attempt;
    const timeout = setTimeout(() => attempt.abort(), Math.min(remainingMs, this.#options.connectTimeoutMs ?? 5000));
    let transport: Duplex | undefined;
    const greeting = Promise.withResolvers<unknown>();
    const interrupted = Promise.withResolvers<never>();
    interrupted.promise.catch(() => {});
    greeting.promise.catch(() => {});
    this.#greeting = greeting;
    const abort = () => {
      transport?.destroy();
      greeting.reject(new RemoteError('CONNECT_TIMEOUT', 'Runtime handshake timed out'));
      interrupted.reject(new RemoteError('CONNECT_TIMEOUT', 'Runtime connection attempt timed out'));
    };
    attempt.signal.addEventListener('abort', abort, { once: true });
    try {
      // Factories must honor abort; a late transport is never allowed to become the controller.
      const created = this.#options.connect(attempt.signal).then(stream => {
        if (attempt.signal.aborted) stream.destroy();
        return stream;
      });
      transport = await Promise.race([created, interrupted.promise]);
      if (attempt.signal.aborted) { transport.destroy(); throw new RemoteError('CONNECT_TIMEOUT', 'Transport creation aborted'); }
      this.#transport = transport;
      void this.#read(transport, greeting);
      const prior = this.#hello;
      transport.write(encode({ id: 0, method: 'runtime.hello', params: {
        api: 2, world: this.#options.world,
        required: [...new Set(['runtime.resume', 'request.dedup', ...(this.#options.required ?? [])])],
        ...(prior ? { runtime: prior.runtime, token: prior.token } : {}),
      } }));
      const info = this.#validateHello(await greeting.promise);
      if (prior && (info.runtime !== prior.runtime || info.token !== prior.token)) {
        throw protocolError('Resumed runtime identity changed');
      }
      if (!prior && info.requestHighWater !== 0) throw protocolError('Fresh runtime already admitted requests');
      if (info.requestHighWater > this.#sequence) throw protocolError('Unknown request journal on runtime');
      this.#hello = info;
      // Replay exact serialized requests in original admission order, never with replacement IDs.
      for (const pending of this.#pending.values()) transport.write(pending.frame);
    } catch (error) {
      if (this.#transport === transport) this.#transport = undefined;
      transport?.destroy();
      throw error;
    } finally {
      clearTimeout(timeout);
      attempt.signal.removeEventListener('abort', abort);
      if (this.#greeting === greeting) this.#greeting = undefined;
    }
  }

  #validateHello(value: unknown): Hello {
    const h = object(value);
    for (const key of ['runtime', 'token', 'world', 'build', 'platform', 'arch']) {
      if (typeof h[key] !== 'string' || !h[key]) throw protocolError(`Invalid hello ${key}`);
    }
    if (h.api !== 2 || h.world !== this.#options.world) throw protocolError('Incompatible runtime greeting');
    if (!Array.isArray(h.capabilities) || h.capabilities.some(cap => typeof cap !== 'string')) throw protocolError('Invalid capabilities');
    for (const required of ['runtime.resume', 'request.dedup', ...(this.#options.required ?? [])]) {
      if (!h.capabilities.includes(required)) throw new RemoteError('UNSUPPORTED', `Missing runtime capability: ${required}`);
    }
    for (const key of ['graceMs', 'leaseMs', 'requestHighWater']) {
      if (!Number.isSafeInteger(h[key]) || (h[key] as number) < (key === 'requestHighWater' ? 0 : 100)) throw protocolError(`Invalid hello ${key}`);
    }
    const limits = object(h.limits);
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || (value as number) <= 0) throw protocolError('Invalid runtime limit');
    if (limits.frameBytes !== MAX_FRAME || typeof limits.chunkBytes !== 'number' || limits.chunkBytes > 32768
        || typeof limits.requests !== 'number' || limits.requests < 1) throw protocolError('Unsupported framing or request limits');
    if (h.inputWaiting !== 'unknown' || h.cleanupScope !== 'observed-session-members') throw protocolError('Unsupported observation contract');
    return h as unknown as Hello;
  }

  async #read(transport: Duplex, greeting: ReturnType<typeof Promise.withResolvers<unknown>>): Promise<void> {
    let welcomed = false;
    try {
      for await (const message of frames(transport)) {
        if (transport !== this.#transport) return;
        if ('id' in message) {
          if (!Number.isSafeInteger(message.id) || (message.id as number) < 0
              || (('result' in message) === ('error' in message)) || 'event' in message) throw protocolError('Invalid response envelope');
          let error: RemoteError | undefined;
          if ('error' in message) {
            const e = object(message.error);
            if (typeof e.code !== 'string' || typeof e.message !== 'string') throw protocolError('Invalid remote error');
            error = new RemoteError(e.code, e.message, e.details as Json);
          }
          if (!welcomed) {
            if (message.id !== 0) throw protocolError('Expected hello response');
            welcomed = true;
            if (error) greeting.reject(error); else greeting.resolve(message.result);
          } else {
            if (message.id === 0 || (message.id as number) > this.#sequence) throw protocolError('Unknown response ID');
            const p = this.#pending.get(message.id as number);
            if (!p) continue; // Duplicate responses from same-session retransmission.
            this.#pending.delete(p.id);
            this.#bytes -= p.frame.length;
            p.removeAbort();
            if (error) p.reject(error); else p.resolve(message.result);
            for (const waiting of this.#pending.values()) this.#cancel(waiting);
          }
        } else {
          if (!welcomed || !['stream.data', 'process.state'].includes(message.event as string) || !('value' in message)) throw protocolError('Invalid event envelope');
          this.emit(message.event as string, message.value);
        }
      }
      throw new RemoteError('TRANSPORT_CLOSED', 'Runtime transport closed');
    } catch (error) {
      greeting.reject(error);
      if (transport !== this.#transport) return;
      this.#transport = undefined;
      transport.destroy();
      if (error instanceof RemoteError && error.code === 'PROTOCOL_ERROR') this.#fail(error);
      else if (this.#state === 'ready') this.#beginRecovery();
      else if (this.#state === 'closing') this.#fail(error);
    }
  }

  #startHeartbeat(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      if (this.#state === 'ready' && ![...this.#pending.values()].some(p => p.method === 'runtime.ping')) {
        void this.request('runtime.ping', {}).catch(() => {});
      }
    }, Math.max(25, Math.floor(this.#hello!.leaseMs / 3)));
    this.#heartbeat.unref();
  }

  #beginRecovery(): void {
    if (this.#recovering || !this.#hello) return;
    this.#setState('reconnecting');
    this.#recovering = this.#recover().finally(() => { this.#recovering = undefined; });
  }

  async #recover(): Promise<void> {
    const end = Date.now() + this.#hello!.graceMs;
    while (this.#state === 'reconnecting' && Date.now() < end) {
      try {
        await this.#connect(Math.max(1, end - Date.now()));
        if (this.#state !== 'reconnecting') return;
        if (!this.#transport) throw new RemoteError('TRANSPORT_CLOSED', 'Transport closed during resume');
        this.#setState('ready');
        for (const p of this.#pending.values()) this.#cancel(p);
        return;
      } catch (error) {
        if (error instanceof RemoteError && ['SESSION_MISMATCH', 'SESSION_EXPIRED', 'INCOMPATIBLE_VERSION', 'UNSUPPORTED', 'PROTOCOL_ERROR'].includes(error.code)) {
          this.#fail(error); return;
        }
        await delay(Math.min(100, Math.max(0, end - Date.now())));
      }
    }
    if (this.#state === 'reconnecting') this.#fail(new RemoteError('WORLD_LOST', 'Runtime reconnect grace exhausted'));
  }

  /** Administrative transport interruption; outstanding work stays owned by this runtime. */
  reconnect(): void {
    if (this.#state !== 'ready') return;
    const transport = this.#transport;
    this.#transport = undefined;
    transport?.destroy();
    this.#beginRecovery();
  }

  async whenReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RemoteError('CANCELLED', 'Readiness wait cancelled before admission');
    if (this.#state === 'reconnecting') await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.off('state', changed); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new RemoteError('CANCELLED', 'Readiness wait cancelled before admission')); };
      const changed = (state: ClientState) => {
        if (state !== 'reconnecting') { cleanup(); resolve(); }
      };
      this.on('state', changed);
      signal?.addEventListener('abort', abort, { once: true });
      changed(this.#state);
    });
    if (this.#state !== 'ready') throw this.#failure ?? new RemoteError('WORLD_NOT_READY', `World is ${this.#state}`);
  }

  /** Bounded wait for local admission; remote errors/unknown outcomes are never retried with new IDs. */
  async requestWhenReady<T = unknown>(method: string, params: Params, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new RemoteError('CANCELLED', 'Request aborted before admission');
    if (this.#waiting >= (controls.has(method) ? 40 : 32)) throw new RemoteError('CLIENT_RESOURCE_LIMIT', 'Local admission wait capacity exhausted');
    this.#waiting++;
    try {
      while (true) {
        await this.whenReady(signal);
        try { return await this.request<T>(method, params, signal); }
        catch (error) {
          if (!(error instanceof AdmissionError) || !(error.code === 'CLIENT_RESOURCE_LIMIT' || (error.code === 'WORLD_NOT_READY' && this.#state === 'reconnecting'))) throw error;
          await delay(10, undefined, { signal });
        }
      }
    } finally { this.#waiting--; }
  }

  request<T = unknown>(method: string, params: Params, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new RemoteError('CANCELLED', 'Request aborted before admission'));
    if (this.#state !== 'ready' && !(this.#state === 'closing' && method === 'runtime.shutdown')) {
      return Promise.reject(this.#failure ?? new AdmissionError('WORLD_NOT_READY', `World is ${this.#state}`));
    }
    const control = controls.has(method);
    const count = [...this.#pending.values()].filter(p => p.control === control).length;
    if (count >= (control ? 8 : Math.min(24, this.#hello!.limits.requests!)) || this.#sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new AdmissionError('CLIENT_RESOURCE_LIMIT', 'Pending request capacity exhausted'));
    }
    const id = this.#sequence + 1;
    let frame: Buffer;
    try { frame = encode({ id, method, params }); } catch (error) { return Promise.reject(error); }
    if (this.#bytes + frame.length > 4 * 1024 * 1024 + (control ? 256 * 1024 : 0)) {
      return Promise.reject(new AdmissionError('CLIENT_RESOURCE_LIMIT', 'Pending request byte budget exhausted'));
    }
    const result = Promise.withResolvers<T>();
    const p: Pending = { id, method, frame, control, resolve: value => result.resolve(value as T), reject: result.reject,
      removeAbort: () => signal?.removeEventListener('abort', abort), cancelWanted: false, cancelSent: false };
    const abort = () => { p.cancelWanted = true; this.#cancel(p); };
    signal?.addEventListener('abort', abort, { once: true });
    this.#pending.set(id, p);
    this.#sequence = id;
    this.#bytes += frame.length;
    this.#transport!.write(frame);
    return result.promise;
  }

  #cancel(p: Pending): void {
    if (!p.cancelWanted || p.cancelSent || this.#state !== 'ready') return;
    // A fan-out abort must leave control slots for termination, acknowledgements and heartbeat.
    if ([...this.#pending.values()].filter(p => p.method === 'runtime.cancel').length >= 2) return;
    p.cancelSent = true;
    void this.request('runtime.cancel', { request: p.id }).catch(() => { p.cancelSent = false; });
  }

  #fail(reason: unknown): void {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    this.#failure = reason instanceof RemoteError ? reason : new RemoteError('WORLD_LOST', 'Runtime connection failed');
    clearInterval(this.#heartbeat);
    this.#attempt?.abort();
    const transport = this.#transport;
    this.#transport = undefined;
    transport?.destroy();
    this.#greeting?.reject(this.#failure);
    this.#setState('failed');
    for (const p of this.#pending.values()) {
      p.removeAbort();
      p.reject(new RemoteError('OUTCOME_UNKNOWN', `Lost response to ${p.method}; it must not be automatically re-executed`, { request: p.id, cause: this.#failure.code }));
    }
    this.#pending.clear();
    this.#bytes = 0;
    this.emit('failure', this.#failure);
  }

  /** Detach without claiming remote cleanup; the finite remote grace still applies. */
  dispose(): void { this.#fail(new RemoteError('WORLD_DISPOSED', 'Controller disposed; remote cleanup is unconfirmed')); }

  shutdown(deadlineMs = 5000): Promise<void> {
    this.#close ??= (async () => {
      await this.whenReady();
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 35000) throw new Error('Invalid cleanup deadline');
      this.#setState('closing');
      clearInterval(this.#heartbeat);
      try {
        const result = await this.request<{ cleanupComplete: boolean }>('runtime.shutdown', { deadlineMs });
        if (!result.cleanupComplete) throw new RemoteError('CLEANUP_INCOMPLETE', 'Runtime cleanup was not confirmed');
        for (const p of this.#pending.values()) {
          p.removeAbort();
          p.reject(new RemoteError('WORLD_CLOSED', 'Runtime closed before this response was observed'));
        }
        this.#pending.clear(); this.#bytes = 0;
        this.#setState('closed');
        this.#transport?.destroy(); this.#transport = undefined;
      } catch (error) { this.#fail(error); throw error; }
    })();
    return this.#close;
  }
}
