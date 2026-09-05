import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as localRead } from 'node:fs/promises';
import { RemoteProcess, writeFile, readFile } from '../../packages/client/src/index.ts';
import { connectSuppliedRuntime, sshArguments } from '../../packages/ssh/src/index.ts';

const host = process.env.DSH_TEST_HOST;
const helper = process.env.DSH_TEST_REMOTE_HELPER;
const fixture = process.env.DSH_TEST_REMOTE_FIXTURE;
const rg = process.env.DSH_TEST_REMOTE_RG;
const run = promisify(execFile);

test('system OpenSSH: remote files, large collection, raw resume, search and scoped cleanup', { skip: !host, timeout: 120000 }, async () => {
  assert.ok(host && helper && fixture && rg, 'Explicit remote artifacts are required');
  const target = { host, ...(process.env.DSH_TEST_SSH_CONFIG ? { configFile: process.env.DSH_TEST_SSH_CONFIG } : {}) };
  const command = async (argv: string[]) => (await run('ssh', sshArguments(target, argv), { timeout: 20000, maxBuffer: 65536 })).stdout;
  const root = (await command(['mktemp', '-d', '/tmp/dsh-client-ssh.XXXXXXXX'])).trim();
  assert.match(root, /^\/tmp\/dsh-client-ssh\.[A-Za-z0-9]+$/);
  let client: Awaited<ReturnType<typeof connectSuppliedRuntime>> | undefined;
  try {
    await command([helper, 'start', '--runtime-dir', `${root}/runtime`, '--cwd', root, '--grace-ms', '10000', '--lease-ms', '5000']);
    client = await connectSuppliedRuntime({ ...target, world: 'ssh-test', helper, socket: `${root}/runtime/socket` });
    const path = `${root}/remote-only.txt`;
    const created = await writeFile(client, path, Buffer.from('remote needle\n'), { kind: 'absent' });
    assert.equal(created.metadata!.version, (await client.request<{ version: string }>('fs.stat', { path })).version);
    assert.equal((await readFile(client, path, 100)).data.toString(), 'remote needle\n');
    await assert.rejects(localRead(path), { code: 'ENOENT' });
    const process = await RemoteProcess.spawn(client, { argv: [fixture, 'burst', '20000000'], cwd: root,
      stdout: { mode: 'collect', maxBytes: 20000000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    await process.done;
    assert.equal(process.collected[0]!.readBytes().data.length, 20000000);
    assert.equal(process.collected[0]!.readFrom(0).lossy, false);
    await process.release();
    const raw = await RemoteProcess.spawn(client, { argv: [fixture, 'burst', '80000'], cwd: root, stdout: { mode: 'raw', maxBytes: 4096 }, stderr: { mode: 'collect', maxBytes: 1024 }, drainMs: 10000 });
    const iterator = raw.raw(0);
    const first = await iterator.next();
    client.reconnect(); await client.whenReady();
    const chunks = [first.value!]; for await (const data of iterator) chunks.push(data);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(Array.from({ length: 80000 }, (_, i) => (i % 8192) % 251)));
    await raw.done; await raw.release();
    const search = await RemoteProcess.spawn(client, { argv: [rg, '--no-config', 'needle', 'remote-only.txt'], cwd: root, stdout: { mode: 'collect', maxBytes: 20000000 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    assert.equal((await search.done).rootExit?.code, 0);
    assert.equal(search.collected[0]!.readFrom(0).text, 'remote needle\n');
    await search.release();
    const signalled = await RemoteProcess.spawn(client, { argv: [fixture, 'hold'], cwd: root, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
    await client.request('process.signal', { process: signalled.id, signal: 'USR1' });
    assert.equal((await signalled.done).rootExit?.signalName, 'SIGUSR1');
    await signalled.release();
    await client.shutdown();
  } finally {
    if (client?.state === 'ready' || client?.state === 'reconnecting') await client.shutdown();
    client?.dispose();
    await command(['rm', '-r', root]);
  }
});
