import { mkdtemp, mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BindingStore } from '../plugins/ssh-world/src/bindings.ts';
const root = resolve('.');
const upstream = resolve(process.env.DSH_WEB_SOURCE ?? 'target/web-host');
await mkdir('target/web-acceptance', { recursive: true });
const resultFile = resolve('target/web-acceptance/result.json');
await rm(resultFile, { force: true });
const build = JSON.parse(await readFile(`${upstream}/remote-build.json`, 'utf8'));
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
if (build.revision !== series.revision || JSON.stringify(build.patches) !== JSON.stringify(series.patches.map(({ file, sha256 }) => ({ file, sha256 })))) {
  throw new Error('Web host build is stale; run prepare-web-host.mjs against the pinned source');
}
const state = await mkdtemp(resolve('target/web-acceptance/run-'));
try {
  BindingStore.create(`${state}/bindings.json`);
  const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
  const config = { worlds: selection.worlds, bindingFile: `${state}/bindings.json`, bootstrap: {
    manifest: JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST, 'utf8')),
    cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE, graceMs: 15000, leaseMs: 5000,
  } };
  await copyFile('integrations/dsh/tests/e2e/replay.ts', `${upstream}/apps/web/tests/remote-replay.ts`);
  await copyFile('integrations/dsh/tests/e2e/portable-workspace.e2e.ts', `${upstream}/apps/web/tests/portable-workspace.e2e.ts`);
  await copyFile('integrations/dsh/tests/e2e/vitest.config.ts', `${upstream}/vitest.remote.config.ts`);
  const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.remote.config.ts', 'apps/web/tests/portable-workspace.e2e.ts'], {
    cwd: upstream, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, CI: 'true', GIT_CEILING_DIRECTORIES: resolve(upstream, '..'), DSH_SNAPSHOT: 'replay', DSH_REMOTE_CONFIG: JSON.stringify(config), DSH_REMOTE_ROOT: root, DSH_REMOTE_STATE: state },
  });
  const interrupt = () => {
    if (child.pid === undefined) return;
    try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`Browser acceptance exited ${code}`))); });
    await writeFile(resultFile, JSON.stringify({ status: 'passed', completedAt: new Date().toISOString(), ...build,
      scenario: 'portable-workspace.e2e.ts', topology: 'host Web + Chromium; two Docker Linux/SSH Worlds',
      model: 'synthetic replay', search: 'native provider + controlled host HTTP endpoint' }, null, 2) + '\n');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
} finally { await rm(state, { recursive: true, force: true }); }
