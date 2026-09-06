import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { BindingStore } from '../../packages/dsh-ssh/src/bindings.ts';

const definition = { id: 'world-a', kind: 'ssh', host: 'example.invalid', cwd: '/workspace' } as const;
const storeModule = new URL('../../packages/dsh-ssh/src/bindings.ts', import.meta.url).href;

test('binding store preserves immutable identities across instances and process restart', async () => {
  const dir = await mkdtemp('/tmp/dsh-bindings.');
  try {
    const file = `${dir}/bindings.json`, first = BindingStore.create(file), second = new BindingStore(file);
    first.bind('one', definition); second.bind('two', definition);
    assert.deepEqual(first.get('two'), definition);
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { BindingStore } from ${JSON.stringify(storeModule)}; new BindingStore(process.argv[1]).bind('three', JSON.parse(process.argv[2]));`,
      file, JSON.stringify(definition)]);
    assert.deepEqual(new BindingStore(file).get('three'), definition);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const before = fs.readFileSync(file, 'utf8');
    first.bind('one', definition);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    for (const changed of [{ ...definition, host: 'different.invalid' }, { ...definition, cwd: '/different' }, { ...definition, id: 'other' }]) {
      assert.throws(() => first.bind('one', changed), { code: 'WORLD_MISMATCH' });
    }
    assert.throws(() => first.bind('four', { ...definition, cwd: '/different' }), { code: 'WORLD_MISMATCH' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent processes serialize or report busy without losing successful bindings', async () => {
  const dir = await mkdtemp('/tmp/dsh-bindings.');
  try {
    const file = `${dir}/bindings.json`; BindingStore.create(file);
    const source = `import { BindingStore } from ${JSON.stringify(storeModule)};
      import { setTimeout } from 'node:timers/promises';
      const store = new BindingStore(process.argv[1]);
      for (let i = 0; ; i++) { try { store.bind(process.argv[2], JSON.parse(process.argv[3])); break; }
        catch (e) { if (e.code !== 'BINDINGS_BUSY' || i > 100) throw e; await setTimeout(5); } }`;
    await Promise.all(Array.from({ length: 8 }, (_, i) => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', source, file, `session-${i}`, JSON.stringify(definition)])));
    const store = new BindingStore(file);
    for (let i = 0; i < 8; i++) assert.deepEqual(store.get(`session-${i}`), definition);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing, corrupt, future-format, duplicate and unsafe maps fail without replacement', async () => {
  const dir = await mkdtemp('/tmp/dsh-bindings.');
  try {
    const file = `${dir}/bindings.json`, store = BindingStore.create(file);
    store.bind('one', definition);
    const valid = fs.readFileSync(file, 'utf8');
    for (const invalid of ['{', JSON.stringify({ version: 2, worlds: [], sessions: [] }),
      JSON.stringify({ version: 1, worlds: [definition, definition], sessions: [] }),
      JSON.stringify({ version: 1, worlds: [], sessions: [{ sessionId: 'one', worldId: 'missing' }] })]) {
      fs.writeFileSync(file, invalid);
      assert.throws(() => store.get('one'), { code: 'INVALID_BINDINGS' });
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    }
    fs.writeFileSync(file, valid); fs.chmodSync(file, 0o644);
    assert.throws(() => store.get('one'), { code: 'UNSAFE_BINDINGS' });
    fs.unlinkSync(file);
    assert.throws(() => new BindingStore(file), { code: 'BINDINGS_MISSING' });
    assert.equal(fs.existsSync(file), false);
    fs.symlinkSync('/dev/null', file);
    assert.throws(() => new BindingStore(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('write failure preserves the old generation; uncertain post-rename commit blocks this writer', async t => {
  const dir = await mkdtemp('/tmp/dsh-bindings.');
  try {
    const file = `${dir}/bindings.json`, store = BindingStore.create(file);
    store.bind('one', definition);
    const before = fs.readFileSync(file, 'utf8');
    const rename = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
    assert.throws(() => store.bind('two', definition), { code: 'EIO' }); rename.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), ['bindings.json']);
    const sync = fs.fsyncSync;
    const fault = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failure');
      sync(fd);
    });
    assert.throws(() => store.bind('two', definition), { code: 'BINDING_COMMIT_UNKNOWN' }); fault.mock.restore();
    assert.throws(() => store.get('one'), { code: 'BINDING_COMMIT_UNKNOWN' });
    assert.deepEqual(new BindingStore(file).get('two'), definition);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('process killed before rename leaves the prior complete map and refuses lock stealing', async () => {
  const dir = await mkdtemp('/tmp/dsh-bindings.');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const file = `${dir}/bindings.json`, store = BindingStore.create(file);
    store.bind('one', definition);
    const before = fs.readFileSync(file, 'utf8');
    const source = `import fs from 'node:fs'; import { BindingStore } from ${JSON.stringify(storeModule)};
      fs.renameSync = () => { process.send('staged'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
      new BindingStore(process.argv[1]).bind('interrupted', JSON.parse(process.argv[2]));`;
    child = spawn(process.execPath, ['--input-type=module', '-e', source, file, JSON.stringify(definition)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exit = once(child, 'exit');
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGKILL'); await exit;
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(new BindingStore(file).get('interrupted'), undefined);
    assert.throws(() => store.bind('next', definition), { code: 'BINDINGS_BUSY' });
    // The test owns this directory and has observed the writer exit before clearing its lock.
    fs.rmdirSync(`${file}.lock`);
    store.bind('next', definition);
    assert.deepEqual(new BindingStore(file).get('next'), definition);
  } finally { child?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
