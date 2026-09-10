import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const state = await mkdtemp(join(tmpdir(), 'dsh-connect-install-'));
const home = join(state, 'home');
const build = JSON.parse(await readFile('dist/dsh/extension-build.json', 'utf8'));
const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
const launcher = resolve('.build/dsh/official-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
let child, browser, page, requests = 0;
const server = createServer(async (request, response) => {
  if (request.url !== '/runtime') { response.writeHead(404).end(); return; }
  requests++;
  if (requests === 1) { response.writeHead(503).end(); return; }
  try { response.end(await readFile(join(state, 'runtime.tar.gz'))); }
  catch { response.writeHead(503).end(); }
});
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
  try { await exited; } finally { clearTimeout(timer); }
};
try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(state, 'bin'));
  // Only the test SSH executable selects the disposable container config; product code uses ordinary OpenSSH.
  await writeFile(join(state, 'bin/ssh'), '#!/bin/sh\nexec /usr/bin/ssh -F "$DSH_CONNECT_FIXTURE_CONFIG" "$@"\n', { mode: 0o700 });
  const fixtureBuild = join(state, 'build.json');
  // Local builds may be dirty; this transport fixture is never a distributable release candidate.
  await writeFile(fixtureBuild, JSON.stringify({ ...build, sourceDirty: false }));
  await writeFile(join(state, build.filename), await readFile(join('dist/dsh', build.filename)));
  execFileSync(process.execPath, ['integrations/dsh/scripts/pack-release.mjs', fixtureBuild, process.env.DSH_TEST_BOOTSTRAP_MANIFEST,
    process.env.DSH_TEST_ARTIFACT_CACHE, process.env.DSH_TEST_RIPGREP_LICENSE, join(state, 'release')], { stdio: 'pipe' });
  execFileSync('tar', ['-czf', join(state, 'runtime.tar.gz'), '-C', join(state, 'release'), '.']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `https://github.com/aur3l14no/dsh-remote/releases/download/v${build.extensionVersion}/dsh-remote-linux-x86_64.tar.gz`;
  const preload = join(state, 'download-fixture.mjs');
  await writeFile(preload, `const original=globalThis.fetch; globalThis.fetch=(input, options)=>original(input===${JSON.stringify(url)}?${JSON.stringify(`http://127.0.0.1:${server.address().port}/runtime`)}:input,options);\n`);
  const env = { ...process.env, DSH_HOME: home, DSH_CONNECT_FIXTURE_CONFIG: selection.worlds[0].target.configFile,
    PATH: `${join(state, 'bin')}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}` };
  execFileSync(process.execPath, ['--expose-internals', launcher, 'plugin', '--profile', 'web', 'add', resolve('dist/dsh', build.filename)], { env, stdio: 'pipe', timeout: 60000 });
  await assert.rejects(access(join(home, 'remote/config.json')));
  const start = async () => {
    child = spawn(process.execPath, ['--expose-internals', launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('CLI startup timed out')), 60000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/dsh web: (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before readiness')); });
    });
  };
  const endpoint = await start();
  const initial = JSON.parse(await readFile(join(home, 'remote/config.json'), 'utf8'));
  assert.deepEqual(initial.worlds, []); assert.equal(initial.bootstrap, undefined); assert.equal(requests, 0);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ locale: 'en-US' });
  await page.goto(endpoint);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  if (!(await page.getByLabel('SSH host', { exact: true }).isVisible())) await page.getByLabel('Connect or open a workspace', { exact: true }).click();
  await page.getByLabel('SSH host', { exact: true }).fill('world-a');
  await page.getByRole('button', { name: 'Connect to Host', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Runtime download failed (503)' }).waitFor();
  await page.getByRole('button', { name: 'Connect to Host', exact: true }).click();
  await page.getByLabel('Remote directory', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Remote directory"]')?.value.startsWith('/'), undefined, { timeout: 60000 });
  assert.equal(requests, 2);
  await page.getByLabel('Remote directory', { exact: true }).fill('/workspace');
  await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
  await page.locator('[data-composer-input][contenteditable=true]').first().waitFor({ timeout: 30000 });
  const bindings = await readFile(join(home, 'remote/bindings.json'), 'utf8');
  assert.equal(JSON.parse(bindings).sessions.length, 1);
  const config = JSON.parse(await readFile(join(home, 'remote/config.json'), 'utf8'));
  assert.equal(config.worlds.length, 1); assert.equal(config.bootstrap, undefined);
  await stop();
  await rm(join(state, 'runtime.tar.gz')); // Restart must use the private cache, even offline.
  await page.goto(await start());
  if (!(await page.getByLabel('SSH host', { exact: true }).isVisible())) await page.getByLabel('Connect or open a workspace', { exact: true }).click();
  await page.getByLabel('SSH host', { exact: true }).fill('world-a');
  await page.getByRole('button', { name: 'Connect to Host', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Remote directory"]')?.value.startsWith('/'), undefined, { timeout: 60000 });
  assert.equal(requests, 2);
  assert.equal(await readFile(join(home, 'remote/bindings.json'), 'utf8'), bindings);
  await mkdir('artifacts/dsh', { recursive: true });
  await writeFile('artifacts/dsh/connect-install.json', JSON.stringify({ status: 'passed', checks: ['plugin-add-only startup', 'Connect via public-key OpenSSH', 'download failure is retryable', 'automatic runtime download and deployment', 'remote folder and Session', 'offline cache reuse after restart', 'binding preservation'] }, null, 2));
  console.log('PASS clean install → Connect → automatic runtime → Open Folder → offline restart');
} catch (error) {
  if (page) {
    console.log(await page.locator('.portable-workspaces').innerText().catch(() => 'UI unavailable'));
    await page.screenshot({ path: 'artifacts/dsh/web-connect-install.png' }).catch(() => {});
  }
  throw new Error(String(error).replace(/https?:\/\/[^\s]+/g, '[URL]'));
} finally {
  await browser?.close(); await stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(state, { recursive: true, force: true });
}
