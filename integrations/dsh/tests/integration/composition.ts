import assert from 'node:assert/strict';
import { readFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader';
import { runRipgrep, resolveRgPath, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES } from '@deepseek-ai/dsh-tool-fs-search';
import { worldPlugin } from '../../packages/world/ssh-world/src/world.ts';
import SshFileSystem from '../../packages/world/ssh-world/src/fs.ts';
import SshSubprocess from '../../packages/world/ssh-world/src/subprocess.ts';
import { runtime, fixture as nativeFixture } from '../../../../runtime/tests/client/support.ts';
import { remoteRuntime } from './remote-runtime.ts';

const ssh = !!process.env.DSH_TEST_HOST;
const localRg = process.env.DSH_TEST_RG;
const fixture = ssh ? process.env.DSH_TEST_REMOTE_FIXTURE : nativeFixture;
if (!localRg || !fixture) throw new Error('Explicit local identity and target-native artifacts are required');
const r = ssh ? await remoteRuntime('first-world') : await runtime({ lease: 5000 });
const second = ssh ? await remoteRuntime('second-world') : await runtime({ world: 'second-world', lease: 5000 });
const rg = 'ripgrep' in r ? r.ripgrep : ssh ? process.env.DSH_TEST_REMOTE_RG : localRg;
if (!rg) throw new Error('Explicit target-native ripgrep required');
const local = await mkdtemp('/tmp/dsh-composition-local.');
const ctx = new Context();
const originalExecPath = process.execPath;
const originalPkg = Reflect.get(process, 'pkg');
try {
  // Exercise the actual DSH bundled-sidecar resolver without changing any installed executable.
  process.execPath = `${local}/test-harness`;
  Reflect.set(process, 'pkg', {});
  await copyFile(localRg, `${process.execPath}-rg`);
  const packaged = await resolveRgPath();
  assert.equal(packaged, `${local}/test-harness-rg`);
  await ctx.plugin(Loader);
  let remote!: Context;
  ctx.loader.builtins = { group: Group, 'remote-world': worldPlugin(r.client), 'fs-ssh': SshFileSystem, 'subprocess-ssh': SshSubprocess,
    consumer: { name: 'consumer', inject: ['remoteWorld', 'fs', 'subprocess'], apply(scope: Context) { remote = scope; } } };
  const config = JSON.parse(await readFile('integrations/dsh/tests/integration/cordis.yml', 'utf8'));
  config[0].config.find((entry: { id: string }) => entry.id === 'process').config.executables[packaged] = rg;
  await ctx.loader.root.update(config);
  await ctx.loader.await();
  assert.ok(remote);
  assert.equal(ctx.get('fs'), undefined);
  assert.equal(ctx.get('subprocess'), undefined);
  assert.equal(remote.remoteWorld.client, r.client);
  const firstFileSystem = remote.fs;

  const target = await remote.fs.resolve('sentinel.txt');
  const created = await remote.fs.writeText(target, 'remote\r\nneedle\r\n', { kind: 'createIfAbsent' });
  assert.equal((await remote.fs.stat(target))!.version, created.version);
  const edited = await remote.fs.editText(target, { oldString: 'needle\n', newString: 'needle-edited\n', replaceAll: false }, { version: created.version });
  assert.equal(edited.before, 'remote\nneedle\n');
  assert.equal(await remote.fs.readText(target), 'remote\r\nneedle-edited\r\n');
  assert.equal(remote.fs.processPathFromHostPath(`${local}/test-harness-rg`), undefined);
  if (ssh) await assert.rejects(readFile(`${r.dir}/sentinel.txt`), { code: 'ENOENT' });
  await assert.rejects(remote.fs.editText(target, { oldString: 'missing', newString: 'x', replaceAll: false }, { version: created.version }), { code: 'FS_STALE_VERSION' });
  await assert.rejects(remote.fs.writeText(target, 'overwrite', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
  assert.ok((await remote.fs.listDir(await remote.fs.resolve('.'))).some(entry => entry.name === 'sentinel.txt'));
  const streamed = await remote.fs.streamText(target);
  assert.equal((await Array.fromAsync(streamed)).join(''), 'remote\r\nneedle-edited\r\n');

  const subprocess = remote.subprocess.spawn({ argv: [fixture, 'argv', 'literal;$(not-a-shell)'], cwd: r.dir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
  assert.equal(subprocess.collected.stdout!.readFrom(0).text, '');
  assert.equal((await subprocess.done).exitCode, 0);
  assert.equal(subprocess.collected.stdout!.readFrom(0).text, '["literal;$(not-a-shell)"]\n');
  const missing = remote.subprocess.spawn({ argv: [`${r.dir}/missing-program`], cwd: r.dir,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 500 });
  await assert.rejects(missing.done, { code: 'NOT_FOUND' });
  const ignoresInput = remote.subprocess.spawn({ argv: [fixture, 'argv', 'early-exit'], cwd: r.dir,
    stdio: { stdin: { data: 'input'.repeat(50000) }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
  assert.equal((await ignoresInput.done).exitCode, 0);

  // The real search consumer requests its unchanged 20 MB default and passes its exact packaged path.
  const input = 'needle '.repeat(100) + '\n';
  await remote.fs.writeText(await remote.fs.resolve('large.txt'), input.repeat(25000));
  // This consumer fixture supplies the execution fields read by runRipgrep; it does not construct an Agent.
  const searchExecution = (cwd: string) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } }) as Parameters<typeof runRipgrep>[1];
  const exec = searchExecution(r.dir);
  const search = await runRipgrep(remote, exec, 'grep', ['--no-heading', 'needle', 'large.txt'], RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES);
  assert.equal(search.stdout, input.repeat(25000));
  assert.ok(Buffer.byteLength(search.stdout) > 16 * 1024 * 1024);
  await assert.rejects(remote.subprocess.resolveExecutable(`${r.dir}/unrelated/rg`), { code: 'NOT_FOUND' });
  const terminal = await remote.subprocess.spawnTerminal({ argv: ['sh', '-c', 'printf pty-ok'], cwd: r.dir, rows: 24, cols: 80, graceMs: 500 });
  let terminalOutput = '';
  for await (const chunk of terminal.output) terminalOutput += String(chunk);
  assert.equal((await terminal.done).exitCode, 0);
  assert.equal(terminalOutput, 'pty-ok');
  await terminal.terminate();

  // Completed collection handles must not exhaust the helper's 16 process slots.
  for (let i = 0; i < 20; i++) {
    const short = remote.subprocess.spawn({ argv: [fixture, 'argv', String(i)], cwd: r.dir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
    await short.done; await short.waitForExit();
    assert.equal(short.collected.stdout!.readFrom(0).text, `["${i}"]\n`);
  }
  const firstOwner = remote.subprocess.spawn({ argv: [fixture, 'hold'], cwd: r.dir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 200 });
  let shared!: Context;
  ctx.loader.builtins['shared-consumer'] = { name: 'shared-consumer', inject: ['remoteWorld', 'fs', 'subprocess'], apply(scope: Context) { shared = scope; } };
  await ctx.loader.create({ name: 'cordis:group', isolate: { subprocess: true }, config: [
    { id: 'shared-process', name: 'cordis:subprocess-ssh', config: { executables: {} } },
    { id: 'shared-consumer', name: 'cordis:shared-consumer' },
  ] }, 'world');
  await ctx.loader.await();
  assert.equal(shared.remoteWorld.client, r.client);
  assert.notEqual(shared.subprocess, remote.subprocess);
  const sharedProcess = shared.subprocess.spawn({ argv: [fixture, 'hold'], cwd: r.dir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 200 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.loader.remove('process');
  assert.throws(() => remote.subprocess, /inactive context/);
  assert.equal(await firstOwner.waitForExit(), true);
  assert.equal(r.client.state, 'ready');
  assert.equal(await sharedProcess.waitForExit(AbortSignal.timeout(100)), false);
  sharedProcess.terminate(); await sharedProcess.waitForExit();

  // A second isolated group owns distinct providers and rejects first-World file identities.
  let other!: Context;
  ctx.loader.builtins['second-world'] = worldPlugin(second.client);
  ctx.loader.builtins['second-consumer'] = { name: 'second-consumer', inject: ['remoteWorld', 'fs', 'subprocess'], apply(scope: Context) { other = scope; } };
  const otherConfig = JSON.parse(await readFile('integrations/dsh/tests/integration/cordis.yml', 'utf8'))[0];
  otherConfig.id = 'other';
  for (const entry of otherConfig.config) {
    entry.id = 'other-' + entry.id;
    if (entry.name === 'cordis:remote-world') entry.name = 'cordis:second-world';
    if (entry.name === 'cordis:consumer') entry.name = 'cordis:second-consumer';
    if (entry.name === 'cordis:subprocess-ssh') entry.config.executables[packaged] = `${second.dir}/missing-managed-rg`;
  }
  await ctx.loader.create(otherConfig);
  await ctx.loader.await();
  assert.notEqual(firstFileSystem, other.fs);
  assert.throws(() => other.fs.processPath(target), { code: 'FS_IO_ERROR' });
  await other.fs.writeText(await other.fs.resolve('sentinel.txt'), 'needle\n');
  await assert.rejects(runRipgrep(other, searchExecution(second.dir), 'grep', ['needle', 'sentinel.txt'], RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES), { code: 'SEARCH_FAILED' });
  const survivor = other.subprocess.spawn({ argv: [fixture, 'hold'], cwd: second.dir, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 200 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.loader.remove('world');
  assert.equal(r.client.state, 'closed');
  assert.equal(second.client.state, 'ready');
  assert.equal(await survivor.waitForExit(AbortSignal.timeout(100)), false);
  survivor.terminate(); await survivor.waitForExit();
  await ctx.loader.remove('other');
  assert.equal(second.client.state, 'closed');
  console.log('PASS external Loader: scoped FS/subprocess, real DSH search >16 MiB, exact executable mapping, guarded edits, process-slot reuse, shared owners and independent Worlds');
} finally {
  process.execPath = originalExecPath;
  if (originalPkg === undefined) Reflect.deleteProperty(process, 'pkg'); else Reflect.set(process, 'pkg', originalPkg);
  try { await ctx.fiber.dispose(); }
  finally { await r.close(); await second.close(); await rm(local, { recursive: true, force: true }); }
}
