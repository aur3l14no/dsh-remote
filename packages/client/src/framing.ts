import type { Readable } from 'node:stream';
import { object, protocolError } from './protocol.ts';

export const MAX_FRAME = 2 * 1024 * 1024;

export function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value, (_key, value) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw protocolError('Unsupported numeric precision');
    return value;
  }));
  if (!body.length || body.length > MAX_FRAME) throw protocolError('Frame exceeds supported size');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}

/** One bounded frame allocation; UTF-8 and integer precision are checked before dispatch. */
export async function* frames(input: Readable): AsyncGenerator<Record<string, unknown>> {
  let buffer = Buffer.allocUnsafe(4);
  let filled = 0;
  let header = true;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(buffer.length - filled, bytes.length - offset);
      bytes.copy(buffer, filled, offset, offset + count);
      filled += count;
      offset += count;
      if (filled !== buffer.length) continue;
      if (header) {
        const length = buffer.readUInt32BE();
        if (!length || length > MAX_FRAME) throw protocolError('Invalid frame length');
        buffer = Buffer.allocUnsafe(length);
      } else {
        let value: unknown;
        try {
          const text = decoder.decode(buffer);
          value = JSON.parse(text, (_key, value, context?: { source?: string }) => {
          if (typeof value === 'number' && (!Number.isSafeInteger(value)
            || !/^-?(0|[1-9][0-9]*)$/.test(context?.source ?? ''))) {
            throw protocolError('Unsupported numeric precision');
          }
          return value;
          });
        } catch {
          throw protocolError('Invalid UTF-8 JSON or unsupported numeric precision');
        }
        yield object(value);
        buffer = Buffer.allocUnsafe(4);
      }
      filled = 0;
      header = !header;
    }
  }
  if (filled || !header) throw protocolError('Truncated frame');
}
