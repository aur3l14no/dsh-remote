import { baselineRevision } from './baseline.mjs';
// Owns two disposable final environments. Connection coordinates stay in process input/private temp files.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { sshControl } from '../../../runtime/ssh/src/control.ts';

function required(name) {
  assert.ok(process.env[name], `Set ${name} explicitly`);
  return process.env[name];
}
const target = { host: required('DSH_TEST_HOST'), configFile: process.env.DSH_TEST_SSH_CONFIG };
const image = required('DSH_TEST_CONTAINER_IMAGE');
const manifestFile = resolve(required('DSH_TEST_BOOTSTRAP_MANIFEST'));
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
assert.equal(manifest.bundles.length, 1);
assert.equal(manifest.bundles[0].target.os, 'linux');
const cacheDir = resolve(required('DSH_TEST_ARTIFACT_CACHE'));
const rg = resolve(required('DSH_TEST_RG'));
const host = sshControl(target);
const temporary = await mkdtemp('/tmp/dsh-project-catalog.');
const root = `/tmp/dsh-project-${randomUUID()}`;
const path = `${root}/workspace`;
const containers = [];
const checks = [];
let failure;
const started = new Date().toISOString();
try {
  assert.equal((await host(['podman', 'info', '--format', '{{.Host.Security.Rootless}}'])).trim(), 'true');
  const imageId = (await host(['podman', 'image', 'inspect', '--format', '{{.Id}}', image])).trim();
  assert.match(imageId, /^(sha256:)?[a-f0-9]{64}$/);
  const worlds = [];
  for (const id of ['a', 'b']) {
    const container = (await host(['podman', 'run', '--detach', '--rm', '--pull=never', '--network=none',
      '--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges', imageId, 'sleep', '1800'])).trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    containers.push(container);
    const nested = { ...target, podmanContainer: container };
    const control = sshControl(nested);
    await control(['sh', '-c', '! command -v sshd']);
    await control(['mkdir', '-p', '-m', '700', path]);
    worlds.push({ id, name: `World ${id}`, target: { kind: 'ssh', ...nested, installRoot: `${root}/artifacts`, runtimeBase: root } });
  }
  await assert.rejects(access(root), { code: 'ENOENT' });
  await host(['sh', '-c', 'test ! -e "$1"', 'acceptance', root]);
  const configFile = `${temporary}/catalog.json`;
  await writeFile(configFile, JSON.stringify({ worlds, path }), { mode: 0o600 });
  const child = spawn(process.execPath, ['target/composition/project-worlds.mjs'], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_TEST_PROJECT_CONFIG: configFile, DSH_TEST_BOOTSTRAP_MANIFEST: manifestFile,
      DSH_TEST_ARTIFACT_CACHE: cacheDir, DSH_TEST_RG: rg }, signal: AbortSignal.timeout(600000) });
  let output = '', bytes = 0;
  await new Promise((accept, reject) => {
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); reject(new Error('Acceptance output limit exceeded')); return; }
      output += chunk.toString(); process.stdout.write(chunk);
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error(`Project composition failed: ${code}`)));
  });
  checks.push(...output.split('\n').filter(line => line.startsWith('PASS ') || line.startsWith('GAP ')));
  await assert.rejects(access(root), { code: 'ENOENT' });
  await host(['sh', '-c', 'test ! -e "$1"', 'acceptance', root]);
  checks.push('PASS workspace exists only in the two final containers, never on the local host or SSH entry');
} catch (error) { failure = error; }
finally {
  for (const container of containers) {
    try {
      await host(['podman', 'rm', '--force', container]);
      await assert.rejects(host(['podman', 'container', 'exists', container]), { code: 'CONTROL_FAILED' });
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance and cleanup failed') : error; }
  }
  await rm(temporary, { recursive: true, force: true });
}
if (failure) throw failure;
await mkdir('target', { recursive: true });
await writeFile('target/project-worlds-acceptance.json', JSON.stringify({ schema: 1, started, completed: new Date().toISOString(),
  dsh: baselineRevision, platform: manifest.bundles[0].target,
  transport: 'system-ssh/podman-exec', containers: 2, containerNetwork: 'none', sshServerInContainer: false,
  containersRemoved: true, checks,
  limits: ['Source composition with unchanged Web activation controllers; no browser or complete Web profile',
    'Known unprepared Web create and cold-resume gaps prevent shipping the Project experiment as a Web integration'],
}, null, 2) + '\n');
console.log('PASS two-container Project acceptance; both containers removed');
