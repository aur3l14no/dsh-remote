import type { Client } from './client.ts';
import { rawStream } from './streams.ts';
import type { Params } from './protocol.ts';
import { RemoteError } from './protocol.ts';

export interface Metadata { kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; mode: number; version: string }
export type Expected = { kind: 'any' } | { kind: 'absent' } | { kind: 'version'; version: string };
export interface Published { committed: true; kind: 'create' | 'update'; metadata: Metadata | null }

export async function readFile(client: Client, path: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: Buffer; metadata: Metadata }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new RemoteError('CLIENT_RESOURCE_LIMIT', 'Unsupported whole-file read budget');
  return readStream(client, 'fs.read', { path, maxBytes }, maxBytes, signal);
}

export async function readFileRange(client: Client, path: string, offset: number, length: number, signal?: AbortSignal): Promise<{ data: Buffer; metadata: Metadata }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 * 1024) throw new RemoteError('CLIENT_RESOURCE_LIMIT', 'Unsupported byte range');
  if (!client.info.capabilities.includes('fs.read-range')) throw new RemoteError('UNSUPPORTED', 'Helper does not support byte ranges; update the helper');
  return readStream(client, 'fs.readRange', { path, offset, length }, length, signal);
}

async function readStream(client: Client, method: string, params: Params, maxBytes: number, signal?: AbortSignal): Promise<{ data: Buffer; metadata: Metadata }> {
  const opened = await client.requestWhenReady<{ stream: string; metadata: Metadata }>(method, params, signal);
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const bytes of rawStream(client, opened.stream, signal)) {
      length += bytes.length;
      if (length > maxBytes) throw new RemoteError('RESOURCE_LIMIT', 'File grew beyond requested byte budget');
      chunks.push(bytes);
    }
    return { data: Buffer.concat(chunks, length), metadata: opened.metadata };
  } finally {
    if (client.state === 'ready' || client.state === 'reconnecting') {
      await client.whenReady();
      await client.requestWhenReady('stream.close', { stream: opened.stream });
    }
  }
}

export async function writeFile(client: Client, path: string, data: Uint8Array, expected: Expected = { kind: 'any' }, signal?: AbortSignal, writeRoot?: string): Promise<Published> {
  return writeFileStream(client, path, (async function* () { yield data; })(), data.byteLength, expected, signal, writeRoot);
}

/** Publish a known-length file with bounded chunks and backpressure, without aggregating it in memory. */
export async function writeFileStream(client: Client, path: string, data: AsyncIterable<Uint8Array>, bytes: number, expected: Expected = { kind: 'any' }, signal?: AbortSignal, writeRoot?: string): Promise<Published> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > client.info.limits.uploadBytes!) throw new RemoteError('CLIENT_RESOURCE_LIMIT', 'File exceeds remote upload limit');
  if (writeRoot !== undefined && !client.info.capabilities.includes('fs.rooted-publish')) throw new RemoteError('UNSUPPORTED', 'Update the helper to enable workspace-contained writes');
  const { upload } = await client.requestWhenReady<{ upload: string }>('fs.beginWrite', { path, expected, maxBytes: Math.max(1, bytes), ...(writeRoot === undefined ? {} : { writeRoot }) } as Params, signal);
  let committed = false;
  try {
    let offset = 0;
    for await (const chunk of data) {
      signal?.throwIfAborted();
      if (offset + chunk.byteLength > bytes) throw new RemoteError('INVALID_ARGUMENT', 'File stream exceeds its declared length');
      for (let start = 0; start < chunk.byteLength; start += client.info.limits.chunkBytes!) {
        const part = chunk.subarray(start, start + client.info.limits.chunkBytes!);
        await client.requestWhenReady('fs.writeChunk', { upload, offset, data: Buffer.from(part).toString('base64') }, signal);
        offset += part.byteLength;
      }
    }
    if (offset !== bytes) throw new RemoteError('INVALID_ARGUMENT', 'File stream ended before its declared length');
    await client.whenReady();
    const result = await client.requestWhenReady<Published>('fs.commitWrite', { upload }, signal);
    committed = result.committed;
    return result;
  } finally {
    if (!committed && (client.state === 'ready' || client.state === 'reconnecting')) {
      await client.whenReady();
      // A commit can have succeeded despite a missing outcome; abort is never a rollback.
      await client.requestWhenReady('fs.abortWrite', { upload }).catch(error => {
        if (!(error instanceof RemoteError && error.code === 'UNKNOWN_RESOURCE')) throw error;
      });
    }
  }
}
