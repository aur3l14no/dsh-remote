import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { bootstrapSshWorld, connectSuppliedRuntime, sshArguments } from '../../packages/ssh/src/index.ts';

/** Explicit SSH fixture: its setup commands never stand in for a workspace provider call. */
export async function remoteRuntime(world: string) {
  const host = process.env.DSH_TEST_HOST;
  const helper = process.env.DSH_TEST_REMOTE_HELPER;
  const manifest = process.env.DSH_TEST_BOOTSTRAP_MANIFEST;
  assert.ok(host && (helper || manifest), 'Explicit SSH host and helper or manifest are required');
  const target = { host, ...(process.env.DSH_TEST_SSH_CONFIG ? { configFile: process.env.DSH_TEST_SSH_CONFIG } : {}) };
  const run = promisify(execFile);
  const command = async (argv: string[]) => (await run('ssh', sshArguments(target, argv), { timeout: 20000, maxBuffer: 65536 })).stdout;
  const root = (await command(['mktemp', '-d', '/tmp/dsh-composition.XXXXXXXX'])).trim();
  assert.match(root, /^\/tmp\/dsh-composition\.[A-Za-z0-9]+$/);
  if (manifest) {
    assert.ok(process.env.DSH_TEST_ARTIFACT_CACHE, 'Explicit local artifact cache required');
    const ready = await bootstrapSshWorld({ ...target, world, cwd: root, cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE,
      manifest: JSON.parse(await readFile(manifest, 'utf8')), installRoot: `${root}/artifacts` });
    return { client: ready.client, dir: ready.client.info.cwd, ripgrep: ready.ripgrep, async close() { await ready.close(); await command(['chmod', '-R', 'u+w', root]); await command(['rm', '-r', root]); } };
  }
  assert.ok(helper);
  try {
    await command([helper, 'start', '--runtime-dir', `${root}/runtime`, '--cwd', root, '--grace-ms', '15000', '--lease-ms', '5000']);
    const client = await connectSuppliedRuntime({ ...target, world, helper, socket: `${root}/runtime/socket` });
    return { client, dir: client.info.cwd, async close() {
      if (client.state === 'ready' || client.state === 'reconnecting') await client.shutdown();
      client.dispose();
      await command(['rm', '-r', root]);
    } };
  } catch (error) {
    // No workspace operation has been admitted. An unbound helper expires within its startup grace.
    throw error;
  }
}
