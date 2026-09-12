/** Disposable Linux Worlds around any host-side test command, including Vitest/Playwright. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const suite = args.length === 1 && args[0] === '--suite';
const lanes = suite ? [
  ['.build/dsh/patched-host/admission.mjs'],
  ['.build/dsh/composition/shared-runtime.mjs'],
  ['--expose-internals', '.build/dsh/attachment-check/lib/attachments.mjs'],
  ['integrations/dsh/tests/e2e/skills-deployment.mjs'],
  ['integrations/dsh/tests/e2e/worlds-reload.mjs'],
  ['integrations/dsh/scripts/web-e2e.mjs'],
  ['integrations/dsh/scripts/web-e2e.mjs', '--attachments'],
  ['integrations/dsh/scripts/web-e2e.mjs', '--ssh-approval'],
  ['integrations/dsh/scripts/web-e2e.mjs', '--call-environment'],
  ['integrations/dsh/scripts/web-e2e.mjs', '--agent-team'],
  ['integrations/dsh/tests/e2e/extension-install.mjs'],
  ['integrations/dsh/tests/e2e/connect-install.mjs'],
  ['integrations/dsh/scripts/local-e2e.mjs'],
].map(lane => [process.execPath, ...lane]) : [args.slice(1)];
if (!suite && (args[0] !== '--' || args.length < 2)) {
  throw new Error('Usage: node integrations/dsh/scripts/e2e.mjs --suite | -- COMMAND [ARGS...]');
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
await mkdir(resolve(root, '.build/dsh/e2e'), { recursive: true });
const state = await mkdtemp(resolve(root, '.build/dsh/e2e/run-'));
const stack = `dsh-e2e-${state.split('run-').at(-1).toLowerCase()}`;
const compose = ['compose', '-p', stack, '-f', resolve(root, 'integrations/dsh/tests/e2e/compose.yaml')];
let env = { ...process.env };
let active;
let interrupted = false;
const interrupt = () => { interrupted = true; active?.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
async function run(binary, args, { capture = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error('E2E interrupted');
  return await new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    active = child;
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (active === child) active = undefined;
      code === 0 ? accept(output.trim()) : reject(new Error(`${binary} exited ${code ?? signal}`));
    });
  });
}
const docker = (args, options) => run('docker', [...compose, ...args], options);
let started = false;
try {
  const key = resolve(state, 'identity');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  env.DSH_E2E_PUBLIC_KEY = (await readFile(`${key}.pub`, 'utf8')).trim();
  await docker(['build', 'world-a']);
  for (const [index, command] of lanes.entries()) {
    // Fixtures write shared home/project paths and some stop a World. Fresh
    // containers keep lane isolation; the image and immutable artifacts are shared.
    console.log(`E2E lane ${index + 1}/${lanes.length}: ${command.slice(1).join(' ')}`);
    started = true; // Even partial startup must be torn down.
    await docker(['up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90']);
    const knownHosts = resolve(state, 'known_hosts');
    const configFile = resolve(state, 'ssh_config');
    const configs = [], keys = [], worlds = [];
    for (const id of ['a', 'b']) {
      const service = `world-${id}`;
      const address = await docker(['port', service, '22'], { capture: true });
      const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
      if (!match) throw new Error(`Expected one loopback SSH endpoint: ${address}`);
      const port = match[1];
      const hostKey = await docker(['exec', '-T', service, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { capture: true });
      keys.push(`[127.0.0.1]:${port} ${hostKey}`);
      configs.push(`Host ${service}\n  HostName 127.0.0.1\n  Port ${port}\n  User world\n  IdentityFile "${key}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${knownHosts}"\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ConnectTimeout 10`);
      worlds.push({ id, name: `World ${id.toUpperCase()}`, workspaces: [{ name: 'workspace', path: '/workspace' }], target: { kind: 'ssh', host: service, configFile } });
    }
    await writeFile(knownHosts, keys.join('\n') + '\n', { mode: 0o600 });
    await writeFile(configFile, configs.join('\n') + '\n', { mode: 0o600 });
    for (const { id, target } of worlds) {
      const marker = await run('ssh', ['-F', configFile, target.host, 'cat /workspace/world.txt'], { capture: true });
      if (marker !== id) throw new Error('SSH World identity mismatch');
    }
    if (index === 0) {
      await docker(['cp', 'world-a:/opt/dsh-e2e/bin/dsh-remote-helper', resolve(state, 'helper')]);
      await docker(['cp', 'world-a:/usr/bin/rg', resolve(state, 'rg')]);
      env.DSH_TEST_RIPGREP_LICENSE = resolve(state, 'ripgrep-copyright');
      await docker(['cp', 'world-a:/usr/share/doc/ripgrep/copyright', env.DSH_TEST_RIPGREP_LICENSE]);
      const arch = await docker(['exec', '-T', 'world-a', 'uname', '-m'], { capture: true });
      const rgVersion = (await docker(['exec', '-T', 'world-a', 'rg', '--version'], { capture: true })).split('\n')[0].split(' ')[1];
      const cargo = await readFile(resolve(root, 'runtime/helper/Cargo.toml'), 'utf8');
      const helperVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
      if (!helperVersion) throw new Error('Missing helper version');
      env.DSH_TEST_BOOTSTRAP_MANIFEST = resolve(state, 'manifest.json');
      env.DSH_TEST_ARTIFACT_CACHE = resolve(state, 'cache');
      env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG = resolve(state, 'worlds.json');
      await run(process.execPath, ['runtime/scripts/prepare-artifacts.ts', '--os', 'linux', '--arch', arch,
        '--abi', 'glibc', '--minimum-glibc', '2.36', '--helper', resolve(state, 'helper'), '--helper-version', helperVersion,
        '--ripgrep', resolve(state, 'rg'), '--ripgrep-version', rgVersion,
        '--cache', env.DSH_TEST_ARTIFACT_CACHE, '--out', env.DSH_TEST_BOOTSTRAP_MANIFEST]);
    }
    await writeFile(env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, JSON.stringify({ worlds, path: '/workspace' }), { mode: 0o600 });
    env.DSH_TEST_WORLD_CONTAINERS = JSON.stringify({ a: await docker(['ps', '-q', 'world-a'], { capture: true }), b: await docker(['ps', '-q', 'world-b'], { capture: true }) });
    console.log('READY two Linux Worlds: direct SSH, separate Git repositories, identical /workspace path');
    await run(command[0], command.slice(1));
  }
} finally {
  try {
    if (started) await docker(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { cleanup: true });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await rm(state, { recursive: true, force: true });
  }
}
