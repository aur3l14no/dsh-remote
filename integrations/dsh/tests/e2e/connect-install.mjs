import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';

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
  const skillSource = join(state, 'reload-skill');
  await mkdir(skillSource);
  await writeFile(join(skillSource, 'SKILL.md'), '---\nname: reload-proof\ndescription: Reload fixture\n---\nReviewed content\n');
  selection.worlds[0].skills = [{ name: 'reload-proof', source: skillSource }];
  const control = sshControl(selection.worlds[0].target);
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
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByText('Add workspaces to $DSH_HOME/remote/worlds.json, then use Reload worlds.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: selection.worlds }), { mode: 0o600 });
  await page.getByRole('button', { name: 'Worlds config changed. Reload?', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reload worlds' });
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).waitFor();
  await assert.rejects(control(['sh', '-c', 'test -L "$HOME/.agents/skills/reload-proof"']));
  await dialog.locator('summary').filter({ hasText: 'reload-proof' }).click();
  await dialog.locator('summary').filter({ hasText: 'File changes' }).click();
  await dialog.getByText('+ SKILL.md', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/dsh/worlds-reload-preview.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Worlds config changed. Reload?', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await dialog.getByText('Worlds reloaded.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(requests, 0); // Preview and apply skills do not bootstrap a workspace runtime.
  assert.match(await control(['sh', '-c', 'cat "$HOME/.agents/skills/reload-proof/SKILL.md"']), /Reviewed content/);
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
  await page.getByText(/Runtime download failed \(503\)/).waitFor();
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
  await page.locator('.session-card').first().waitFor({ timeout: 60000 });
  assert.equal(requests, 2);
  await page.screenshot({ path: 'artifacts/dsh/workspace-picker-session.png' });
  const firstId = JSON.parse(await readFile(join(home, 'remote/bindings.json'), 'utf8')).sessions[0].sessionId;
  assert.ok(firstId);
  await page.locator('.workspace-new-session').click();
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.session-card').length === 2);
  const cards = page.locator('.session-card');
  const secondLabel = await cards.nth(1).getAttribute('aria-label');
  const secondId = secondLabel.slice('Open session '.length);
  await cards.nth(1).hover();
  await page.getByRole('button', { name: `Pin session ${secondId}`, exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.session-card')?.getAttribute('aria-label') === `Open session ${id}`, secondId);
  await page.getByRole('button', { name: `Unpin session ${secondId}`, exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.session-card')?.getAttribute('aria-label') === `Open session ${id}`, firstId);
  await page.getByRole('button', { name: `Open session ${secondId}`, exact: true }).hover();
  await page.getByRole('button', { name: `Pin session ${secondId}`, exact: true }).click();
  await page.getByRole('button', { name: `Unpin session ${secondId}`, exact: true }).waitFor();
  const bindings = await readFile(join(home, 'remote/bindings.json'), 'utf8');
  assert.equal(JSON.parse(bindings).sessions.length, 2);
  const reloadCatalog = async worlds => {
    await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds }));
    await page.getByRole('button', { name: 'Worlds config changed. Reload?', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await dialog.getByText('Worlds reloaded.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  };
  // Preview an update, then edit the config again before approval.
  selection.worlds[0].color = '#336699';
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: selection.worlds }));
  await page.getByRole('button', { name: 'Worlds config changed. Reload?', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).waitFor();
  selection.worlds[0].color = '#4488aa';
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: selection.worlds }));
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await dialog.getByText(/Worlds config changed since preview/).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const changedTarget = selection.worlds.map((world, index) => index ? world : { ...world, target: { ...world.target, host: 'never-connect-to-this-target' } });
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: changedTarget }));
  await page.getByRole('button', { name: 'Worlds config changed. Reload?', exact: true }).click();
  await dialog.getByText(/target changed; use a new World id/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Apply changes', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Retirement preserves existing Session membership and execution bindings.
  await reloadCatalog([selection.worlds[1]]);
  assert.equal(await readFile(join(home, 'remote/bindings.json'), 'utf8'), bindings);
  await page.getByRole('button', { name: `Open session ${firstId}`, exact: true }).click();
  await page.getByRole('button', { name: `Open session ${firstId}`, exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
  await assert.rejects(control(['sh', '-c', 'test -L "$HOME/.agents/skills/reload-proof"']));
  await stop();
  await page.goto(await start());
  await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  const retiredFile = new URL('/api/file', page.url());
  retiredFile.searchParams.set('path', '/workspace/world.txt');
  retiredFile.searchParams.set('sessionId', firstId);
  const retiredResponse = await page.request.get(retiredFile.href);
  assert.equal(retiredResponse.status(), 200);
  assert.equal((await retiredResponse.text()).trim(), selection.worlds[0].id);
  await reloadCatalog(selection.worlds);
  assert.equal(await readFile(join(home, 'remote/bindings.json'), 'utf8'), bindings);
  const config = JSON.parse(await readFile(join(home, 'remote/config.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(home, 'remote/worlds.json'), 'utf8')).worlds.length, 2);
  assert.equal(config.bootstrap, undefined);
  await stop();
  await rm(join(state, 'runtime.tar.gz')); // Restart must use the private cache, even offline.
  await page.goto(await start());
  await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  await page.locator('.workspace-new-session').click();
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.screenshot({ path: 'artifacts/dsh/workspace-picker-open.png' });
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
  await page.locator('.session-card[aria-current]').waitFor({ timeout: 60000 });
  assert.equal(requests, 2);
  assert.equal(await readFile(join(home, 'remote/bindings.json'), 'utf8'), bindings);
  assert.equal(await cards.first().getAttribute('aria-label'), secondLabel);
  await cards.first().hover();
  await page.getByRole('button', { name: `Unpin session ${secondId}`, exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/dsh/sidebar-hover-actions.png' });
  const longTitle = 'Review workspace routing and session lifecycle across multiple Worlds';
  const renamed = await page.evaluate(async ({ sessionId, title }) => {
    const response = await fetch('/api/session/rename', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/rename', payload: { args: { request: { sessionId, title } } } }) });
    return (await response.json()).result;
  }, { sessionId: secondId, title: longTitle });
  assert.equal(renamed.ok, true);
  await page.waitForFunction(title => document.querySelector('.session-card .session-title')?.textContent === title, longTitle);
  assert.equal(await cards.first().locator('.session-title').evaluate(element => element.scrollWidth > element.clientWidth), true);
  await cards.first().hover();
  await page.getByRole('tooltip').filter({ hasText: longTitle }).waitFor();
  await page.screenshot({ path: 'artifacts/dsh/sidebar-hover-details.png', clip: { x: 12, y: 128, width: 720, height: 220 } });
  // A late directory response cannot override a newer Session selection.
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  await page.route('**/api/portableWorkspace/create', async route => { await paused; await route.continue(); });
  await page.locator('.workspace-new-session').click();
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  const requested = page.waitForRequest(request => request.url().endsWith('/api/portableWorkspace/create'));
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).nth(1).click();
  await requested;
  await page.getByRole('button', { name: `Open session ${firstId}`, exact: true }).click();
  const responded = page.waitForResponse(response => response.url().endsWith('/api/portableWorkspace/create'));
  release();
  await responded;
  await page.unroute('**/api/portableWorkspace/create');
  assert.equal(await page.locator('.session-card[aria-current]').getAttribute('aria-label'), `Open session ${firstId}`);
  await page.getByRole('button', { name: `Open session ${secondId}`, exact: true }).hover();

  await page.getByRole('button', { name: `Archive session ${secondId}`, exact: true }).click();
  await page.getByRole('button', { name: `Open session ${secondId}`, exact: true }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: 'Configure later', exact: true }).click();
  await page.getByRole('button', { name: `Open session ${firstId}`, exact: true }).waitFor();
  assert.equal(await cards.count(), 1);

  await mkdir('artifacts/dsh', { recursive: true });
  await writeFile('artifacts/dsh/connect-install.json', JSON.stringify({ status: 'passed', checks: ['plugin-add-only startup', 'worlds.json hot reload via dry run and confirmation', 'cancel leaves remote unchanged', 'stale config refuses approval', 'World target changes rejected', 'retired World file reads after cold restart preserve Session bindings', 'managed skills removal and re-enable', 'download failure is retryable', 'automatic runtime download and deployment', 'remote folder and Session', 'offline cache reuse after restart', 'binding preservation', 'hover pin and archive controls', 'pin and unpin ordering', 'pin survives host restart', 'archived pin stays hidden after reload', 'long title truncation and detail tooltip', 'late picker response preserves newer navigation'] }, null, 2));
  console.log('PASS clean install → worlds.json dry run/apply → picker → automatic runtime → retirement → offline restart');
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
