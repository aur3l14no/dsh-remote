import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { deploySkills } from '../plugins/skills/src/deploy.ts';
import { sshControl } from '../../../runtime/ssh/src/control.ts';
import yaml from 'js-yaml';
import { BindingStore } from '../plugins/ssh-world/src/bindings.ts';
const root = resolve('.');
const upstream = resolve('target/browser-fixtures');
const installation = resolve(process.env.DSH_TEST_INSTALL ?? 'target/official-install');
await mkdir('target/web-acceptance', { recursive: true });
const live = process.argv[2] === '--live';
const liveEnvironment = {};
if (live) {
  if (!process.argv[3]) throw new Error('Live acceptance requires a private DeepSeek-only config directory');
  const credentials = yaml.load(await readFile(resolve(process.argv[3], '.credentials.yaml'), 'utf8'));
  const key = credentials?.refs?.DEEPSEEK_API_KEY;
  if (typeof key !== 'string' || !key) throw new Error('DeepSeek credential unavailable');
  liveEnvironment.DEEPSEEK_API_KEY = key;
}
const scenario = live ? 'remote-live.e2e.ts' : 'portable-workspace.e2e.ts';
const resultFile = resolve(`target/web-acceptance/${live ? 'live-result' : 'result'}.json`);
await rm(resultFile, { force: true });
if (live) await rm(resolve('target/web-acceptance/live-details.json'), { force: true });
const extension = resolve('target/plugin-home/profiles/web/node_modules/@dsh-remote/extension');
const build = JSON.parse(await readFile(`${extension}/extension.json`, 'utf8'));
const state = await mkdtemp(resolve('target/web-acceptance/run-'));
try {
  BindingStore.create(`${state}/bindings.json`);
  const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
  for (const world of selection.worlds) {
    await deploySkills({ target: world.target, skills: [{ name: 'remote-proof', source: resolve('integrations/dsh/tests/e2e/skills/remote-proof') }] });
    await sshControl(world.target)(['sh', '-c', 'printf "%s\\n" "$1" > /workspace/AGENTS.md; printf marker > "/workspace/only-$3.txt"; mkdir -p /workspace/.agents/skills/world-skill /workspace/nested; printf NESTED_WORLD_INSTRUCTIONS > /workspace/nested/AGENTS.md; printf nested > /workspace/nested/file.txt; printf "%s\\n" "$2" > /workspace/.agents/skills/world-skill/SKILL.md', 'dsh-context-fixture',
      `WORLD_INSTRUCTIONS_${world.id.toUpperCase()}: Keep all workspace operations in this World.`,
      `---\nname: world-${world.id}\ndescription: Instructions available only in World ${world.id}.\n---\nWORLD_SKILL_${world.id.toUpperCase()}`, world.id]);
  }
  const config = { worlds: selection.worlds, bindingFile: `${state}/bindings.json`, bootstrap: {
    manifest: JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST, 'utf8')),
    cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE, graceMs: 15000, leaseMs: 5000,
  } };
  await mkdir(`${state}/home/remote`, { recursive: true, mode: 0o700 });
  await writeFile(`${state}/home/remote/config.json`, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', resolve('integrations/dsh/tests/e2e/installed.vitest.config.mjs'), `apps/web/tests/${scenario}`], {
    cwd: upstream, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, ...liveEnvironment, DSH_TEST_INSTALL: installation, DSH_TEST_EXTENSION: extension, CI: 'true', GIT_CEILING_DIRECTORIES: resolve(upstream, '..'), DSH_SNAPSHOT: live ? 'record' : 'replay', DSH_REMOTE_CONFIG: JSON.stringify(config), DSH_REMOTE_ROOT: root, DSH_REMOTE_STATE: state },
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
      scenario, topology: 'host Web + Chromium; two Docker Linux/SSH Worlds',
      ...(live ? { checks: JSON.parse(await readFile('target/web-acceptance/live-details.json', 'utf8')) } : {}),
      model: live ? 'live DeepSeek API' : 'synthetic replay and native MockAdapter', search: live ? 'native provider + external DeepSeek search' : 'native provider + controlled host HTTP endpoint' }, null, 2) + '\n');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
} finally { await rm(state, { recursive: true, force: true }); }
