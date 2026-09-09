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

export async function writeFile(client: Client, path: string, data: Uint8Array, expected: Expected = { kind: 'any' }, signal?: AbortSignal): Promise<Published> {
  if (data.length > client.info.limits.uploadBytes!) throw new RemoteError('CLIENT_RESOURCE_LIMIT', 'File exceeds remote upload limit');
  const bytes = Buffer.from(data);
  const { upload } = await client.requestWhenReady<{ upload: string }>('fs.beginWrite', { path, expected, maxBytes: Math.max(1, bytes.length) } as Params, signal);
  let committed = false;
  try {
    for (let offset = 0; offset < bytes.length; offset += client.info.limits.chunkBytes!) {
      await client.whenReady();
      await client.requestWhenReady('fs.writeChunk', { upload, offset, data: bytes.subarray(offset, offset + client.info.limits.chunkBytes!).toString('base64') }, signal);
    }
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
