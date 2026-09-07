import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from './client.ts';
import { decodeBytes, RemoteError, snapshot } from './protocol.ts';
import type { Snapshot } from './protocol.ts';

/** Byte-coordinate ring. Replayed/overlapping snapshots cannot duplicate bytes. */
export class CollectedStream {
  #buffer: Buffer;
  #start = 0;
  #end = 0;
  #revision = -1;
  #spill?: string;
  #eof = false;
  #produced = 0;
  #error?: RemoteError;
  readonly id: string;

  constructor(id: string, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('Unsupported collection budget');
    this.id = id;
    this.#buffer = Buffer.allocUnsafe(maxBytes);
  }
  get complete(): boolean { return this.#eof && this.#end === this.#produced; }
  get nextOffset(): number { return this.#end; }

  install(value: unknown): void {
    const s = snapshot(value);
    if (s.stream !== this.id || s.mode !== 'collect') throw new Error('Stream identity mismatch');
    if (s.revision >= this.#revision) {
      this.#revision = s.revision;
      this.#spill = s.spill ?? undefined;
      this.#eof = s.eof;
      this.#produced = s.produced;
      this.#error = s.error ? new RemoteError(s.error.code, s.error.message, s.error.details) : undefined;
    }
    if (s.next <= this.#end) return;
    if (s.offset > this.#end) this.#start = this.#end = s.offset;
    const data = decodeBytes(s.data).subarray(Math.max(0, this.#end - s.offset));
    const keep = data.subarray(Math.max(0, data.length - this.#buffer.length));
    const start = s.next - keep.length;
    const index = start % this.#buffer.length;
    const first = Math.min(keep.length, this.#buffer.length - index);
    keep.copy(this.#buffer, index, 0, first);
    keep.copy(this.#buffer, 0, first);
    this.#end = s.next;
    this.#start = Math.max(this.#start, this.#end - this.#buffer.length);
  }

  readBytes(fromByte = 0): { data: Buffer; nextOffset: number; lossy: boolean; spillPath?: string } {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > this.#end) throw new Error('Invalid collection offset');
    const start = Math.max(fromByte, this.#start);
    const length = this.#end - start;
    const data = Buffer.allocUnsafe(length);
    const index = start % this.#buffer.length;
    const first = Math.min(length, this.#buffer.length - index);
    this.#buffer.copy(data, 0, index, index + first);
    this.#buffer.copy(data, first, 0, length - first);
    return { data, nextOffset: this.#end, lossy: fromByte < this.#start, ...(this.#spill ? { spillPath: this.#spill } : {}) };
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const { data, ...result } = this.readBytes(fromByte);
    // Do not invent replacement characters for a UTF-8 sequence still being produced.
    let length = data.length;
    if (!this.#eof) {
      let start = Math.max(0, length - 3);
      while (start < length && (data[start]! & 0xc0) === 0x80) start++;
      for (let i = start; i < length; i++) {
        const byte = data[i]!;
        const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        if (i + width > length) { length = i; break; }
      }
    }
    return { ...result, text: data.subarray(0, length).toString('utf8'), nextOffset: result.nextOffset - (data.length - length) };
  }

  async finalize(client: Client): Promise<void> {
    while (!this.complete) {
      await client.whenReady();
      const value = await client.requestWhenReady<Snapshot>('stream.read', { stream: this.id, offset: this.#end });
      this.install(value);
      if (!this.complete && value.next === value.produced) await delay(20);
    }
    if (this.#error) throw this.#error;
  }
}

/** Each next() acknowledges the previous chunk, after the consumer has processed it. */
export async function* rawStream(client: Client, stream: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  let offset = 0;
  while (true) {
    if (signal?.aborted) throw new RemoteError('CANCELLED', 'Stream consumption aborted');
    await client.whenReady();
    const s = snapshot(await client.requestWhenReady('stream.read', { stream, offset }, signal));
    if (s.mode !== 'raw' || s.stream !== stream || s.gap || s.offset !== offset) throw new RemoteError('OUTPUT_GAP', 'Raw output is no longer available at the expected offset');
    const bytes = decodeBytes(s.data);
    if (bytes.length) {
      yield bytes;
      await client.whenReady();
      await client.requestWhenReady('stream.ack', { stream, offset: s.next });
      offset = s.next;
    }
    if (s.eof && offset === s.produced) {
      if (s.error) throw new RemoteError(s.error.code, s.error.message, s.error.details);
      return;
    }
    if (!bytes.length) await delay(20, undefined, { signal });
  }
}
