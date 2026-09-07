// Acceptance orchestrator only: owns a disposable container, never DSH Agents or messaging.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sshControl } from '../../../runtime/ssh/src/control.ts';
import { bootstrapSshWorld } from '../../../runtime/ssh/src/index.ts';

function required(name) {
  const value = process.env[name];
  assert.ok(value, `Set ${name} explicitly`);
  return value;
}
const host = required('DSH_TEST_HOST');
const image = required('DSH_TEST_CONTAINER_IMAGE');
const source = required('DSH_SOURCE');
const manifestFile = resolve(required('DSH_TEST_BOOTSTRAP_MANIFEST'));
const cache = resolve(required('DSH_TEST_ARTIFACT_CACHE'));
const fixture = resolve(required('DSH_TEST_FIXTURE'));
const rg = resolve(required('DSH_TEST_RG'));
assert.ok(process.argv.slice(2).every(arg => arg === '--package'), 'Only --package is supported');
const packaged = process.argv.includes('--package');
const build = packaged ? JSON.parse(await readFile('target/packages/plugin-build.json', 'utf8')) : undefined;
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
assert.equal(manifest.bundles.length, 1, 'Acceptance requires one explicitly selected Linux bundle');
const bundle = manifest.bundles[0];
assert.equal(bundle.target.os, 'linux');
const fixtureHash = createHash('sha256').update(await readFile(fixture)).digest('hex');
const target = { host, configFile: process.env.DSH_TEST_SSH_CONFIG };
const hostControl = sshControl(target);
const checks = [];
const started = new Date().toISOString();
let container;
let failure;
let report;

async function run(suite, args, env) {
  console.log(`Running ${suite}`);
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', bytes = 0;
  const timer = setTimeout(() => child.kill('SIGTERM'), 600000);
  try {
    await new Promise((accept, reject) => {
      const receive = chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { child.kill(); reject(new Error('Acceptance output limit')); return; }
        output += chunk.toString(); process.stdout.write(chunk);
      };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', reject);
      child.once('close', code => code === 0 ? accept() : reject(new Error(`${suite} failed: ${code}`)));
    });
    const counts = Object.fromEntries([...output.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
    checks.push({ suite, passed: true, counts, observations: output.split('\n').filter(line => line.startsWith('PASS ')) });
  } finally { clearTimeout(timer); }
}

try {
  console.log('Inspecting the SSH entry and cached container image');
  // Reuse an explicitly selected cached image. No registry login, package installation, mounts or ports.
  assert.equal((await hostControl(['podman', 'info', '--format', '{{.Host.Security.Rootless}}'])).trim(), 'true', 'Acceptance requires rootless Podman');
  const imageId = (await hostControl(['podman', 'image', 'inspect', '--format', '{{.Id}}', image])).trim();
  assert.match(imageId, /^(sha256:)?[a-f0-9]{64}$/);
  container = (await hostControl(['podman', 'run', '--detach', '--rm', '--pull=never', '--network=none',
    '--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges', imageId, 'sleep', '1800'])).trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  console.log('Created the disposable container; preparing its final environment');
  const nested = { ...target, podmanContainer: container };
  const control = sshControl(nested);
  await control(['sh', '-c', '! command -v sshd']);
  const root = (await control(['mktemp', '-d', '/tmp/dsh-nested.XXXXXXXX'])).trim();
  assert.match(root, /^\/tmp\/dsh-nested\.[A-Za-z0-9]{8}$/);
  await assert.rejects(access(root), { code: 'ENOENT' });
  await hostControl(['sh', '-c', 'test ! -e "$1"', 'acceptance', root]);
  await control(['sh', '-c', 'umask 077; cat > "$1"; chmod 700 "$1"', 'acceptance', `${root}/fixture`], { input: createReadStream(fixture) });
  assert.equal((await control(['sha256sum', `${root}/fixture`])).split(' ')[0], fixtureHash);
  const env = { DSH_TEST_PODMAN_CONTAINER: container, DSH_TEST_REMOTE_FIXTURE: `${root}/fixture`,
    DSH_TEST_BOOTSTRAP_MANIFEST: manifestFile, DSH_TEST_ARTIFACT_CACHE: cache, DSH_TEST_RG: rg,
    DSH_BOOTSTRAP_HELPER: `${cache}/${bundle.helper.artifact.sha256}`, DSH_BOOTSTRAP_RG: `${cache}/${bundle.ripgrep.artifact.sha256}`,
    DSH_TEST_RG_MODE: 'npm', DSH_TEST_PACKAGED: '0', DSH_TEST_TERMINAL_SHELL: '/bin/bash' };
  if (packaged) {
    await run('package-session-routing', ['target/package-check/accept.mjs'], { ...env, DSH_TEST_PACKAGED: '1' });
  } else {
    const ready = await bootstrapSshWorld({ ...nested, world: 'nested-transport', cwd: root, manifest, cacheDir: cache, installRoot: `${root}/artifacts` });
    try {
      await run('client', ['--test', 'runtime/tests/client/ssh.test.ts'], { ...env, DSH_TEST_REMOTE_HELPER: ready.installation.helper, DSH_TEST_REMOTE_RG: ready.ripgrep });
    } finally { await ready.close(); }
    await run('bootstrap', ['--test', 'runtime/tests/bootstrap/install.test.ts'], env);
    for (const suite of ['session-routing', 'terminal']) {
      await run(`build-${suite}`, ['integrations/dsh/scripts/build-composition.mjs', source, suite], env);
      await run(suite, [`target/composition/${suite}.mjs`], env);
    }
  }
  // Removing the selected container must fail the target, without executing the command on the SSH host.
  await hostControl(['podman', 'rm', '--force', container]);
  container = undefined;
  await assert.rejects(control(['printf', 'must-not-run-on-host']), { code: 'CONTROL_FAILED' });
  await assert.rejects(bootstrapSshWorld({ ...nested, world: 'removed-container', cwd: root, manifest, cacheDir: cache }), { code: 'CONTROL_FAILED' });
  checks.push({ suite: 'removed-container', passed: true, observations: ['Removed final environment refuses control and bootstrap without selecting the SSH host'] });
  report = { schema: 1, started, completed: new Date().toISOString(), platform: bundle.target, transport: 'system-ssh/podman-exec',
    imageId, helper: bundle.helper.version, helperSha256: bundle.helper.artifact.sha256, fixtureSha256: fixtureHash,
    ...(build ? { package: { file: build.package, integrity: build.integrity,
      sha256: createHash('sha256').update(await readFile(`target/packages/${build.package}`)).digest('hex') } } : {}),
    sshServerInContainer: false, containerNetwork: 'none', checks,
    limits: ['Source-built DSH fixtures; no Web application or model-driven cross-root communication', 'Terminal consumer fixture uses one World; shared-router terminal initialization remains unverified'] };
} catch (error) { failure = error; }
finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) {
    try { await hostControl(['podman', 'rm', '--force', container]); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance and container cleanup failed') : error; }
  }
}
if (failure) throw failure;
await mkdir('target', { recursive: true });
await writeFile(`target/podman${packaged ? '-package' : ''}-acceptance.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log('PASS SSH → Podman exec acceptance; disposable container removed');
