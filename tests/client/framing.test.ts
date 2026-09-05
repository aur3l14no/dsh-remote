import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { frames, encode } from '../../packages/client/src/framing.ts';
import { Client, CollectedStream } from '../../packages/client/src/index.ts';

test('framing preserves fragmented/coalesced frames and rejects malformed data without rounding', async () => {
  const bytes = Buffer.concat([encode({ id: 1, result: '你好\u0000' }), encode({ id: 2, result: 9007199254740991 })]);
  const parts = Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1));
  assert.deepEqual(await Array.fromAsync(frames(Readable.from(parts))), [{ id: 1, result: '你好\u0000' }, { id: 2, result: 9007199254740991 }]);
  for (const body of [Buffer.from('{"id":9007199254740993}'), Buffer.from('{"offset":9007199254740990.5}'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), Buffer.from('{broken')]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    await assert.rejects(Array.fromAsync(frames(Readable.from([header, body]))), { code: 'PROTOCOL_ERROR' });
  }
  await assert.rejects(Array.fromAsync(frames(Readable.from([Buffer.from([0, 0, 0, 0])]))), { code: 'PROTOCOL_ERROR' });
  await assert.rejects(Array.fromAsync(frames(Readable.from([bytes.subarray(0, 8)]))), { code: 'PROTOCOL_ERROR' });
});

test('collection merges replay, truncation and split UTF-8 with original byte offsets', () => {
  const mirror = new CollectedStream('stream', 8);
  const install = (offset: number, bytes: Buffer, eof = false, revision = offset) => mirror.install({ stream: 'stream', mode: 'collect', offset, next: offset + bytes.length,
    produced: offset + bytes.length, retainedFrom: offset, gap: offset > 0, data: bytes.toString('base64'), eof, error: null, spill: null, revision });
  install(0, Buffer.from([0xe4]));
  assert.equal(mirror.readFrom(0).text, ''); assert.equal(mirror.readFrom(0).nextOffset, 0);
  install(0, Buffer.from('你好'), false, 2);
  assert.equal(mirror.readFrom(0).text, '你好');
  install(0, Buffer.from('你好'), false, 2);
  assert.equal(mirror.readBytes().data.length, 6);
  install(20, Buffer.from('1234567890'), true, 3);
  assert.deepEqual(mirror.readFrom(0), { text: '34567890', nextOffset: 30, lossy: true });
  assert.equal(mirror.complete, true);
});

test('a nonresponsive transport factory cannot outlive the connection deadline', { timeout: 1000 }, async () => {
  await assert.rejects(Client.open({ world: 'timeout', connectTimeoutMs: 20, connect: () => new Promise(() => {}) }), { code: 'CONNECT_TIMEOUT' });
});
