import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import yaml from 'js-yaml';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve('.');
const build = JSON.parse(await readFile('target/web-host/remote-build.json', 'utf8'));
assert.equal(build.scaffold, false, 'Build with --production before CLI acceptance');
const credentialHome = process.argv[2];
await mkdir('target/web-acceptance', { recursive: true });
const resultFile = resolve(`target/web-acceptance/source-install${credentialHome ? '-live' : ''}.json`);
await rm(resultFile, { force: true });
const { chromium } = createRequire(resolve('target/web-host/apps/web/package.json'))('playwright');
const state = await mkdtemp(resolve('target/e2e/source-install-'));
const home = `${state}/home`;
const launcher = resolve('integrations/dsh/scripts/start-web.mjs');
let child;
let browser;
let page;
try {
  const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
  const config = { worlds: selection.worlds, bootstrap: {
    manifest: JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST, 'utf8')),
    cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE, graceMs: 15000, leaseMs: 5000,
  } };
  await writeFile(`${state}/config.json`, JSON.stringify(config), { mode: 0o600 });
  execFileSync(process.execPath, [launcher, 'init', home, `${state}/config.json`], { stdio: 'pipe' });
  if (credentialHome) {
    const credentials = yaml.load(await readFile(resolve(credentialHome, '.credentials.yaml'), 'utf8'));
    const key = credentials?.refs?.DEEPSEEK_API_KEY;
    assert.equal(typeof key, 'string');
    await writeFile(`${home}/.credentials.yaml`, yaml.dump({ version: credentials.version, refs: { DEEPSEEK_API_KEY: key } }), { mode: 0o600 });
    await writeFile(`${home}/settings.yaml`, yaml.dump({ 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), { mode: 0o600 });
  }
  assert.throws(() => execFileSync(process.execPath, [launcher, 'init', home, `${state}/config.json`], { stdio: 'pipe' }));
  child = spawn(process.execPath, [launcher, 'start', home, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(resolve('target/web-acceptance/source-cli.private.log'), { mode: 0o600 });
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
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ locale: 'en-US' });
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (!credentialHome) await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  await page.getByLabel('World', { exact: true }).selectOption('a');
  await page.getByLabel('Remote directory', { exact: true }).click();
  await page.getByLabel('Remote directory', { exact: true }).fill('/workspace');
  await page.getByRole('button', { name: 'Add portable workspace', exact: true }).click();
  await page.locator('[data-composer-input][contenteditable=true]').first().waitFor({ timeout: 30000 });
  const bindings = JSON.parse(await readFile(`${home}/bindings.json`, 'utf8'));
  assert.equal(bindings.sessions.length, 1);
  assert.equal(bindings.worlds.length, 1);
  assert.equal(bindings.worlds[0].cwd, '/workspace');
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
    host: 'native DSH CLI, no scaffold', liveRemoteExecution: Boolean(credentialHome), checks: ['exclusive initialization', 'native first-run welcome', 'profile and browser module loading', 'remote workspace bootstrap', 'session binding before composer',
      ...(credentialHome ? ['real-model remote script execution', 'independent remote test rerun', 'remote credential absent', 'other World unchanged'] : [])],
  }, null, 2) + '\n');
  console.log('PASS source-install CLI and Playwright remote workspace creation');
} catch (error) {
  if (page) {
    console.log('CLI workspace diagnostic:', await page.locator('.portable-workspaces').innerText().catch(() => 'unavailable'));
    await page.screenshot({ path: resolve('target/web-source-install.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise(accept => child.once('exit', accept));
    child.kill('SIGTERM');
    const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 10000);
    try { await exited; } finally { clearTimeout(kill); }
  }
  await rm(state, { recursive: true, force: true });
}
