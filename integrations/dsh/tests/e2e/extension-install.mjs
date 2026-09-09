import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import yaml from 'js-yaml';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
import { createRequire } from 'node:module';
import { resolve, join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const root = resolve('.');
const installation = resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install');
const build = JSON.parse(await readFile('dist/dsh/extension-build.json', 'utf8'));
const archive = resolve('dist/dsh', build.filename);
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
assert.equal(build.dshVersion, series.release.version);
assert.equal(build.revision, series.revision);
const credentialHome = process.argv[2];
const videoDirectory = process.env.DSH_E2E_VIDEO_DIR && resolve(process.env.DSH_E2E_VIDEO_DIR);
await mkdir('artifacts/dsh', { recursive: true });
await mkdir('.build/dsh/logs', { recursive: true, mode: 0o700 });
const resultFile = resolve(`artifacts/dsh/extension-install${credentialHome ? '-live' : ''}.json`);
await rm(resultFile, { force: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const state = await mkdtemp(join(tmpdir(), 'dsh-extension-install-'));
const home = `${state}/home`;
const launcher = `${installation}/node_modules/@deepseek-ai/dsh/lib/bin.js`;
const environment = { ...process.env, DSH_HOME: `~/${relative(homedir(), home)}` };
const plugin = (...args) => execFileSync(process.execPath, ['--expose-internals', launcher, 'plugin', '--profile', 'web', ...args], { env: environment, stdio: 'pipe' });
let child;
let browser;
let page;
try {
  const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
  const skillSource = `${state}/remote-proof`;
  await cp(resolve('integrations/dsh/tests/e2e/skills/remote-proof'), skillSource, { recursive: true });
  await writeFile(`${skillSource}/sync-proof.txt`, 'automatic');
  const config = { worlds: selection.worlds.map(world => ({ ...world,
    skills: [{ name: 'remote-proof', source: skillSource }],
  })) };
  const releaseDirectory = process.env.DSH_TEST_RELEASE_OUTPUT ? resolve(process.env.DSH_TEST_RELEASE_OUTPUT) : `${state}/release`;
  execFileSync(process.execPath, ['integrations/dsh/scripts/pack-release.mjs', 'dist/dsh/extension-build.json',
    process.env.DSH_TEST_BOOTSTRAP_MANIFEST, process.env.DSH_TEST_ARTIFACT_CACHE, process.env.DSH_TEST_RIPGREP_LICENSE, releaseDirectory], { stdio: 'pipe' });
  await writeFile(`${state}/config.json`, JSON.stringify(config), { mode: 0o600 });
  await mkdir(home, { mode: 0o700 });
  plugin('add', archive);
  plugin('exec', 'dsh-remote-config', 'init-release', releaseDirectory, `${state}/config.json`);
  const initialized = JSON.parse(await readFile(`${home}/remote/config.json`, 'utf8'));
  assert.equal(initialized.bootstrap.cacheDir, `${home}/remote/artifacts`);
  // Initialization owns its cache; bootstrap must not depend on the download directory.
  if (!process.env.DSH_TEST_RELEASE_OUTPUT) await rm(releaseDirectory, { recursive: true });
  if (credentialHome) {
    const credentials = yaml.load(await readFile(resolve(credentialHome, '.credentials.yaml'), 'utf8'));
    const key = credentials?.refs?.DEEPSEEK_API_KEY;
    assert.equal(typeof key, 'string');
    await writeFile(`${home}/.credentials.yaml`, yaml.dump({ version: credentials.version, refs: { DEEPSEEK_API_KEY: key } }), { mode: 0o600 });
    await writeFile(`${home}/settings.yaml`, yaml.dump({ 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), { mode: 0o600 });
  }
  await writeFile(`${state}/legacy-config.json`, JSON.stringify({ ...config, bootstrap: initialized.bootstrap }), { mode: 0o600 });
  assert.throws(() => plugin('exec', 'dsh-remote-config', 'init', `${state}/legacy-config.json`));
  child = spawn(process.execPath, ['--expose-internals', launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(resolve('.build/dsh/logs/extension-cli.private.log'), { mode: 0o600 });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  // Never print the process-token URL or raw host output into public evidence.
  const url = await new Promise((accept, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('CLI startup timed out')), 60000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/dsh web: (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); accept(match[1]); }
    });
    child.stderr.on('data', () => {});
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited ${code} before readiness`)); });
  });
  browser = await chromium.launch({ headless: true, ...(videoDirectory ? { slowMo: 350 } : {}) });
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 },
    ...(videoDirectory ? { recordVideo: { dir: videoDirectory, size: { width: 1440, height: 900 } } } : {}),
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (!credentialHome) await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  await page.getByLabel('World', { exact: true }).selectOption('a');
  await page.getByLabel('Remote directory', { exact: true }).click();
  await page.getByLabel('Remote directory', { exact: true }).fill('/workspace');
  await rm(`${skillSource}/SKILL.md`);
  await page.getByRole('button', { name: 'Add portable workspace', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Selected skill has no SKILL.md' }).waitFor();
  assert.equal(JSON.parse(await readFile(`${home}/remote/bindings.json`, 'utf8')).sessions.length, 0);
  await cp(resolve('integrations/dsh/tests/e2e/skills/remote-proof/SKILL.md'), `${skillSource}/SKILL.md`);
  await page.getByRole('button', { name: 'Add portable workspace', exact: true }).click();
  await page.locator('[data-composer-input][contenteditable=true]').first().waitFor({ timeout: 30000 });
  const bindings = JSON.parse(await readFile(`${home}/remote/bindings.json`, 'utf8'));
  assert.equal(bindings.sessions.length, 1);
  assert.equal(bindings.worlds.length, 1);
  assert.equal(bindings.worlds[0].cwd, '/workspace');
  const control = sshControl(selection.worlds.find(world => world.id === 'a').target);
  const readSynced = () => control(['sh', '-c', 'cat "$HOME/.agents/skills/remote-proof/sync-proof.txt"']);
  assert.equal(await readSynced(), 'automatic');
  const helperPids = () => control(['sh', '-c', 'pgrep -x dsh-remote | sort -n']);
  const beforeSync = await helperPids();
  assert.ok(beforeSync.trim(), 'Expected a running helper');
  await writeFile(`${skillSource}/sync-proof.txt`, 'manual');
  await page.getByRole('button', { name: 'Sync Skills', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Synced 1 skills' }).waitFor();
  assert.equal(await readSynced(), 'manual');
  assert.equal(await helperPids(), beforeSync, 'Skill sync must preserve helper processes');
  await rm(`${skillSource}/SKILL.md`);
  await page.getByRole('button', { name: 'Sync Skills', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Selected skill has no SKILL.md' }).waitFor();
  assert.equal(await readSynced(), 'manual', 'Failed sync must preserve the deployed skill');
  await cp(resolve('integrations/dsh/tests/e2e/skills/remote-proof/SKILL.md'), `${skillSource}/SKILL.md`);
  if (credentialHome) {
    const input = page.locator('[data-composer-input][contenteditable=true]').first();
    await input.fill('Without delegation, use bash to write a shell script cli-proof.sh in the current workspace that checks 2 + 3 = 5, checks DEEPSEEK_API_KEY is unset without printing it, and writes CLI_TOOL_PASSED into cli-proof.txt. Execute the script. Then finish.');
    await input.press('Enter');
    const controlA = sshControl(selection.worlds.find(world => world.id === 'a').target);
    const controlB = sshControl(selection.worlds.find(world => world.id === 'b').target);
    const deadline = Date.now() + 150000;
    let passed = false;
    while (Date.now() < deadline) {
      try { passed = (await controlA(['cat', '/workspace/cli-proof.txt'])).trim() === 'CLI_TOOL_PASSED'; } catch {}
      if (passed) break;
      await new Promise(accept => setTimeout(accept, 1000));
    }
    assert.ok(passed, 'Real CLI model did not execute the remote test');
    await controlA(['sh', '-c', 'cd /workspace; sh cli-proof.sh; test -z "${DEEPSEEK_API_KEY+x}"']);
    await controlB(['test', '!', '-e', '/workspace/cli-proof.txt']);
  }
  await writeFile(resultFile, JSON.stringify({ status: 'passed', completedAt: new Date().toISOString(), ...build,
    host: 'native DSH CLI, no scaffold', liveRemoteExecution: Boolean(credentialHome), checks: ['exclusive initialization', 'native first-run welcome', 'profile and browser module loading', 'remote workspace bootstrap', 'session binding before composer', 'failed preconnect sync blocks binding and allows retry', 'automatic skill sync', 'manual skill sync without helper restart', 'failed sync preserves deployed skill',
      ...(credentialHome ? ['real-model remote script execution', 'independent remote test rerun', 'remote credential absent', 'other World unchanged'] : [])],
  }, null, 2) + '\n');
  console.log('PASS extension-install CLI and Playwright remote workspace creation');
  if (videoDirectory) {
    await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden', timeout: 120000 });
    await page.waitForTimeout(5000);
  }
} catch (error) {
  if (page) {
    console.log('CLI workspace diagnostic:', await page.locator('.portable-workspaces').innerText().catch(() => 'unavailable'));
    await page.screenshot({ path: resolve('artifacts/dsh/web-extension-install.png') }).catch(() => {});
  }
  throw new Error(String(error).replace(/https?:\/\/[^\s]+/g, '[URL]'));
} finally {
  await browser?.close();
  if (videoDirectory && page?.video()) console.log(`Browser recording: ${await page.video().path()}`);
  if (child && child.exitCode === null) {
    const exited = new Promise(accept => child.once('exit', accept));
    child.kill('SIGTERM');
    const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 10000);
    try { await exited; } finally { clearTimeout(kill); }
  }
  await rm(state, { recursive: true, force: true });
}
