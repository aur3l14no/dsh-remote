import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, Readable, Writable } from 'node:stream';
import { readFile as localRead } from 'node:fs/promises';
import { encode, frames } from '../../client/src/framing.ts';
import { RemoteProcess, readFile, writeFile } from '../../client/src/index.ts';
import type { TransportFactory } from '../../client/src/index.ts';
import { runtime, fixture } from './support.ts';

/** Discard one successful response after the real helper has executed the operation. */
function fault(method: string, remoteCode?: string) {
  let target: number | undefined;
  let dropped = false;
  const attempts: Buffer[] = [];
  const wrap = (factory: TransportFactory): TransportFactory => async signal => {
    const socket = await factory(signal);
    const writable = new Writable({ write(chunk: Buffer, _encoding, callback) {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === method && (target === undefined || target === message.id)) {
        target = message.id; attempts.push(Buffer.from(chunk));
      }
      socket.write(chunk, callback);
    } });
    const readable = Readable.from((async function* () {
      try {
        for await (const message of frames(socket)) {
          if (!dropped && message.id === target && 'result' in message) {
            dropped = true;
            if (remoteCode) { yield encode({ id: target, error: { code: remoteCode, message: 'Injected remote error' } }); continue; }
            socket.destroy(); return;
          }
          yield encode(message);
        }
      } finally { socket.destroy(); }
    })(), { objectMode: false });
    const transport = Duplex.from({ readable, writable });
    transport.once('close', () => socket.destroy());
    return transport;
  };
  return { wrap, verify() { assert.equal(dropped, true); assert.equal(attempts.length, remoteCode ? 1 : 2); if (!remoteCode) assert.deepEqual(attempts[0], attempts[1]); } };
}

test('a remote error cannot masquerade as safe local admission retry', { timeout: 10000 }, async () => {
  const failure = fault('process.spawn', 'CLIENT_RESOURCE_LIMIT');
  const r = await runtime({ wrap: failure.wrap });
  try {
    await assert.rejects(RemoteProcess.spawn(r.client, { argv: [fixture, 'append', `${r.dir}/once`], cwd: r.dir }), { code: 'CLIENT_RESOURCE_LIMIT' });
    failure.verify();
  } finally { await r.close(); }
});

for (const method of ['process.spawn', 'fs.commitWrite', 'process.write', 'stream.ack']) {
  test(`real helper: reconnect deduplicates a lost ${method} response`, { timeout: 15000 }, async () => {
    const failure = fault(method);
    const r = await runtime({ wrap: failure.wrap });
    try {
      if (method === 'process.spawn') {
        const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'append', `${r.dir}/once`], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
        await process.done;
        assert.equal(await localRead(`${r.dir}/once`, 'utf8'), 'once\n');
        await process.release();
      } else if (method === 'fs.commitWrite') {
        // Retrying this guarded create with a new ID would report CREATE_CONFLICT.
        const result = await writeFile(r.client, `${r.dir}/once`, Buffer.from('committed'), { kind: 'absent' });
        assert.equal(result.committed, true);
        assert.equal((await readFile(r.client, `${r.dir}/once`, 100)).data.toString(), 'committed');
      } else if (method === 'process.write') {
        const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'echo'], cwd: r.dir, stdin: 'pipe', stdout: { mode: 'collect', maxBytes: 100000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
        const input = Buffer.alloc(80000, 43);
        await process.write(input); await process.closeStdin(); await process.done;
        assert.deepEqual(process.collected[0]!.readBytes().data, input);
        await process.release();
      } else {
        await writeFile(r.client, `${r.dir}/once`, Buffer.alloc(80000, 44));
        assert.deepEqual((await readFile(r.client, `${r.dir}/once`, 80000)).data, Buffer.alloc(80000, 44));
      }
      failure.verify();
    } finally { await r.close(); }
  });
}

test('real helper: pending capacity reserves cancellation while writes are blocked', { timeout: 15000 }, async () => {
  const r = await runtime();
  try {
    const spawned = await r.client.request<{ process: string }>('process.spawn', { argv: [fixture, 'hold'], cwd: r.dir, stdin: 'pipe' });
    const abort = new AbortController();
    const blocked = Array.from({ length: 24 }, () => r.client.request('process.write', { process: spawned.process, data: Buffer.alloc(32768).toString('base64') }, abort.signal).catch(error => error));
    await assert.rejects(r.client.request('fs.stat', { path: r.dir }), { code: 'CLIENT_RESOURCE_LIMIT' });
    abort.abort();
    await r.client.request('process.terminate', { process: spawned.process });
    await Promise.all(blocked);
  } finally { await r.close(); }
});
