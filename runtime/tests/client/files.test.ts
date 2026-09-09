import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, symlink } from 'node:fs/promises';
import { readFile, writeFileStream } from '../../client/src/index.ts';
import { runtime } from './support.ts';

test('real helper: streamed writes publish complete bytes and abort incomplete sources', async () => {
  const r = await runtime();
  const source = async function* (bytes: Uint8Array) { yield bytes.subarray(0, 3); yield bytes.subarray(3); };
  try {
    const bytes = Buffer.alloc(200000, 193);
    const path = `${r.dir}/nested/file`;
    await writeFileStream(r.client, path, source(bytes), bytes.length, { kind: 'absent' });
    assert.deepEqual((await readFile(r.client, path, bytes.length)).data, bytes);
    assert.ok(r.client.info.capabilities.includes('fs.sync'));
    await r.client.request('fs.sync', { path });
    await assert.rejects(r.client.request('fs.sync', { path: `${r.dir}/nested` }), { code: 'NOT_REGULAR_FILE' });
    await symlink(path, `${r.dir}/link`);
    await assert.rejects(r.client.request('fs.sync', { path: `${r.dir}/link` }));
    const before = await readdir(`${r.dir}/nested`);
    for (const length of [bytes.length - 1, bytes.length + 1]) {
      await assert.rejects(writeFileStream(r.client, `${r.dir}/nested/incomplete`, source(bytes), length), { code: 'INVALID_ARGUMENT' });
      assert.deepEqual(await readdir(`${r.dir}/nested`), before);
    }
    await assert.rejects(writeFileStream(r.client, path, (async function* () { yield bytes; throw new Error('source failed'); })(), bytes.length), /source failed/);
    assert.deepEqual((await readFile(r.client, path, bytes.length)).data, bytes);
    const abort = new AbortController();
    await assert.rejects(writeFileStream(r.client, `${r.dir}/nested/cancelled`, (async function* () {
      yield bytes.subarray(0, 3); abort.abort(new Error('stream cancelled')); yield bytes.subarray(3);
    })(), bytes.length, { kind: 'absent' }, abort.signal), /stream cancelled/);
    assert.deepEqual(await readdir(`${r.dir}/nested`), before);
    await assert.rejects(writeFileStream(r.client, path, source(bytes), r.client.info.limits.uploadBytes! + 1), { code: 'CLIENT_RESOURCE_LIMIT' });
  } finally { await r.close(); }
});
