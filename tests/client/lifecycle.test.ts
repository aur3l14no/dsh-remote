import { test } from 'node:test';
import { kill as killProcess } from 'node:process';
import assert from 'node:assert/strict';
import { readFile as localRead } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteProcess, readFile, writeFile } from '../../packages/client/src/index.ts';
import { runtime, fixture } from './support.ts';

test('real helper: binary files, guarded publication, ordered input and final output', { timeout: 20000 }, async () => {
  const r = await runtime();
  try {
    assert.equal('token' in r.client.info, false);
    const bytes = Buffer.from([0, 255, 1, 13, 10, 226, 128, 168]);
    const published = await writeFile(r.client, `${r.dir}/bytes`, bytes, { kind: 'absent' });
    assert.equal(published.committed, true);
    assert.deepEqual((await readFile(r.client, `${r.dir}/bytes`, bytes.length)).data, bytes);
    await assert.rejects(writeFile(r.client, `${r.dir}/bytes`, bytes, { kind: 'absent' }), { code: 'CREATE_CONFLICT' });
    const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'echo'], cwd: r.dir, stdin: 'pipe', stdout: { mode: 'collect', maxBytes: 200000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    const input = Buffer.alloc(100000, 42);
    await Promise.all([process.write(input), process.write(bytes), process.closeStdin()]);
    assert.equal((await process.done).rootExit?.code, 0);
    assert.deepEqual(process.collected[0]!.readBytes().data, Buffer.concat([input, bytes]));
    assert.deepEqual(process.collected[1]!.readBytes().data, Buffer.from([0, 255, 254, 33]));
    await process.release();
    const exited = await RemoteProcess.spawn(r.client, { argv: [fixture, 'argv'], cwd: r.dir, stdin: 'pipe', stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    await exited.done;
    await assert.rejects(exited.write(Buffer.from('late input')), { code: 'INPUT_FAILED' });
    await exited.closeStdin();
    await exited.release();
    await r.client.shutdown();
    assert.equal(r.client.state, 'closed');
  } finally { await r.close(); }
});

test('real helper: raw acknowledgement follows consumption, resumes with no duplicated bytes', { timeout: 20000 }, async () => {
  const r = await runtime();
  try {
    const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'burst', '200000', `${r.dir}/finished`], cwd: r.dir, stdout: { mode: 'raw', maxBytes: 4096 }, stderr: { mode: 'collect', maxBytes: 1024 }, drainMs: 5000 });
    const iterator = process.raw(0);
    const first = await iterator.next();
    assert.equal(first.done, false);
    const before = await r.client.request<{ retainedFrom: number }>('stream.read', { stream: process.outputs[0]!.stream, offset: 0 });
    assert.equal(before.retainedFrom, 0);
    const epoch = r.client.info.runtime;
    r.client.reconnect(); await r.client.whenReady();
    assert.equal(r.client.info.runtime, epoch);
    const chunks = [first.value!];
    for await (const data of iterator) chunks.push(data);
    const actual = Buffer.concat(chunks);
    const expected = Buffer.from(Array.from({ length: 200000 }, (_, i) => (i % 8192) % 251));
    assert.deepEqual(actual, expected);
    assert.equal((await process.done).rootExit?.code, 0);
    await process.release();
  } finally { await r.close(); }
});

test('real helper: 20 MB collection, bounded frames, runtime memory reservation and release', { timeout: 40000 }, async () => {
  const r = await runtime({ lease: 5000 });
  try {
    assert.equal(r.client.info.limits.outputBytesPerRuntime, 64 * 1024 * 1024);
    const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'burst', '20000000'], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 20000000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    assert.equal((await process.done).rootExit?.code, 0);
    const result = process.collected[0]!.readBytes();
    assert.equal(result.lossy, false); assert.equal(result.data.length, 20000000);
    for (let i = 0; i < result.data.length; i++) assert.equal(result.data[i], (i % 8192) % 251);
    const hold = await RemoteProcess.spawn(r.client, { argv: [fixture, 'hold'], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 32 * 1024 * 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    await assert.rejects(RemoteProcess.spawn(r.client, { argv: [fixture, 'hold'], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 20000000 } }), { code: 'RESOURCE_LIMIT' });
    await process.release();
    const reused = await RemoteProcess.spawn(r.client, { argv: [fixture, 'argv', 'budget-reused'], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 20000000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    await reused.done; await reused.release(); await hold.terminate(); await hold.release();
  } finally { await r.close(); }
});

test('real helper: lost runtime fails pending work without inventing exit or replaying in a new epoch', { timeout: 10000 }, async t => {
  const r = await runtime({ grace: 500 });
  try {
    const process = await RemoteProcess.spawn(r.client, { argv: [fixture, 'hold'], cwd: r.dir, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    t.after(() => { try { killProcess(process.pid, 'SIGKILL'); } catch {} });
    const rejected = assert.rejects(process.done);
    r.child.kill('SIGKILL');
    await rejected;
    assert.equal(r.client.state, 'failed');
    await assert.rejects(r.client.request('process.spawn', { argv: [fixture, 'append', `${r.dir}/unexpected`], cwd: r.dir }));
    await assert.rejects(localRead(`${r.dir}/unexpected`), { code: 'ENOENT' });
  } finally { await r.close(); }
});

test('real helper: idle connection heartbeats preserve the inbound lease', { timeout: 5000 }, async () => {
  const r = await runtime({ lease: 200 });
  try { await delay(800); assert.equal(r.client.state, 'ready'); await r.client.request('runtime.ping', {}); }
  finally { await r.close(); }
});
