import type { Client } from '../../../../runtime/client/src/index.ts';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import { WorldRuntimePool } from '../../packages/world/ssh-world/src/runtime-pool.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SshWorldAdapter } from '../../packages/world/ssh-world/src/adapter.ts';
import { workspaceFor, worldDefinition, type SshWorldDefinition, type SshWorkspaceDefinition } from '../../packages/world/execution-world/src/identity.ts';
import { fileAuthorization } from '../../packages/world/ssh-world/src/file-authorization.ts';
import { runtime } from '../../../../runtime/tests/client/support.ts';
import { sshArguments } from '../../../../runtime/ssh/src/index.ts';

const selection = process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG
  ? JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8')) : undefined;
const ssh = !!selection || !!process.env.DSH_TEST_HOST;
const target = selection?.worlds[0].target ?? { host: process.env.DSH_TEST_HOST ?? 'fixture.invalid', configFile: process.env.DSH_TEST_SSH_CONFIG };
const packagedRipgrep = await SearchTools.resolveRgPath();
const command = async (args: string[]) => (await promisify(execFile)('ssh', sshArguments(target, args), { timeout: 20000 })).stdout.trim();
const root = ssh ? await command(['mktemp', '-d', '/tmp/dsh-shared.XXXXXXXX']) : await realpath(await mkdtemp('/tmp/dsh-shared.'));
const world = worldDefinition({ id: 'build-world', kind: 'ssh', ...target });
let connected = 0;
const adapter = new SshWorldAdapter({ packagedRipgrep, bootstrap: {
  manifest: ssh ? JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')) : {},
  cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE ?? root, leaseMs: 5000,
} }, ssh ? undefined : async definition => {
  connected++;
  const helper = await runtime({ world: definition.id, lease: 5000 });
  return { client: helper.client, ripgrep: process.env.DSH_TEST_RG!, close: () => helper.close() };
});
const views: Awaited<ReturnType<typeof adapter.open>>[] = [];
try {
  for (const name of ['a', 'b']) {
    if (ssh) await command(['mkdir', `${root}/${name}`]); else await mkdir(`${root}/${name}`);
  }
  const definitions = ['a', 'b'].map(name => workspaceFor(world, `workspace-${name}`, `${root}/${name}`) as SshWorkspaceDefinition);
  const [a, b] = await Promise.all(definitions.map(definition => adapter.open(definition)));
  views.push(a!, b!);
  const client = a!.remoteWorkspace.client;
  assert.equal(client, b!.remoteWorkspace.client);
  assert.equal(client.info.world, 'build-world');
  assert.equal('cwd' in client.info, false);
  if (!ssh) assert.equal(connected, 1);
  const [pathA, pathB] = await Promise.all([a!.fs.resolve('marker'), b!.fs.resolve('marker')]);
  await Promise.all([a!.fs.writeText(pathA, 'A'), b!.fs.writeText(pathB, 'B')]);
  assert.equal(await a!.fs.readText(pathA), 'A');
  assert.equal(await b!.fs.readText(pathB), 'B');
  const tracedOwner = a!.extend().remoteWorkspace;
  assert.notEqual(tracedOwner, a!.remoteWorkspace, 'Cordis may wrap the same service for another caller');
  assert.equal(tracedOwner.resources, a!.remoteWorkspace.resources, 'Resource ownership survives Cordis context tracing');
  if (client.info.capabilities.includes('fs.rooted-publish')) {
    await fileAuthorization.run({ owner: tracedOwner.resources, root: definitions[0]!.cwd }, () => a!.fs.writeText(pathA, 'A'));
  }
  await assert.rejects(fileAuthorization.run({ owner: a!.remoteWorkspace.resources, root: definitions[0]!.cwd }, () => b!.fs.writeText(pathB, 'unauthorized')), /another workspace owner/);
  const spawn = (view: typeof a, cwd: string) => view!.subprocess.spawn({ argv: ['/bin/sh', '-c', 'pwd; sleep 30'], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 100 });
  const processA = spawn(a, definitions[0]!.cwd), processB = spawn(b, definitions[1]!.cwd);
  const terminal = (view: typeof a, cwd: string) => view!.subprocess.spawnTerminal({ argv: ['/bin/sh', '-c', 'sleep 30'], cwd, rows: 24, cols: 80, graceMs: 100 });
  const [terminalA, terminalB] = await Promise.all([terminal(a, definitions[0]!.cwd), terminal(b, definitions[1]!.cwd)]);
  await a!.fs.streamText(pathA); // Unconsumed file streams belong to the view as well.
  const staleFs = a!.fs;
  const staleSubprocess = a!.subprocess;
  await a!.fiber.dispose();
  await processA.done;
  await terminalA.done;
  assert.equal(client.state, 'ready');
  await assert.rejects(staleFs.readText(pathA), /owner is closed/);
  await assert.rejects(staleSubprocess.resolveExecutable('sh'), /disposed|closed/);
  assert.ok(await terminalB.inspectForeground());
  assert.equal(await b!.fs.readText(pathB), 'B');
  const epoch = client.info.runtime;
  client.reconnect();
  await client.whenReady();
  assert.equal(client.info.runtime, epoch);
  assert.equal(await b!.fs.readText(pathB), 'B');
  await processB.terminate(); await processB.done;
  assert.ok(processB.collected.stdout!.readFrom(0).text.includes(definitions[1]!.cwd));
  await b!.fiber.dispose();
  await terminalB.done;
  assert.equal(client.state, 'closed');
  const fresh = await adapter.open(definitions[1]!); views.push(fresh);
  assert.notEqual(fresh.remoteWorkspace.client.info.runtime, epoch);
  assert.throws(() => fresh.fs.processPath(pathB), /runtime epoch/);
  console.log('PASS one World shares one Client/helper across concurrent workspace views; cwd, authorization, owner disposal, reconnect and fresh epochs stay distinct');
} finally {
  await Promise.allSettled(views.map(view => view.fiber.dispose()));
  if (ssh) await command(['rm', '-rf', root]); else await rm(root, { recursive: true, force: true });
}

// Pool races do not depend on transport timing: shutdown must finish before replacement.
const closed = Promise.withResolvers<void>();
let starts = 0, stops = 0;
const pool = new WorldRuntimePool(async definition => {
  starts++;
  return { client: { info: { world: definition.id }, state: 'ready' } as Client, ripgrep: '/rg', close: async () => { stops++; await closed.promise; } };
});
const lease = await pool.acquire(world as SshWorldDefinition);
const closing = lease.release();
assert.equal(lease.release(), closing);
const reopening = pool.acquire(world as SshWorldDefinition);
await Promise.resolve(); await Promise.resolve();
assert.equal(starts, 1); assert.equal(stops, 1);
closed.resolve(); await closing;
await (await reopening).release();
assert.equal(starts, 2); assert.equal(stops, 2);
let attempts = 0;
const setupFailure = new Error('setup unavailable');
const retryPool = new WorldRuntimePool(async () => { attempts++; throw setupFailure; });
await assert.rejects(retryPool.acquire(world as SshWorldDefinition), setupFailure);
await assert.rejects(retryPool.acquire(world as SshWorldDefinition), setupFailure);
assert.equal(attempts, 2);
const cleanupFailure = new Error('cleanup unconfirmed');
let failedStarts = 0;
const failedPool = new WorldRuntimePool(async definition => {
  failedStarts++;
  return { client: { info: { world: definition.id }, state: 'ready' } as Client, ripgrep: '/rg', close: async () => { throw cleanupFailure; } };
});
const failedLease = await failedPool.acquire(world as SshWorldDefinition);
await assert.rejects(failedLease.release(), cleanupFailure);
await assert.rejects(failedPool.acquire(world as SshWorldDefinition), cleanupFailure);
assert.equal(failedStarts, 1);
console.log('PASS runtime pool serializes shutdown/reopen, retries failed setup and refuses replacement after unconfirmed cleanup');
