import { recordConversation } from './conversation-history.mjs';
import { checkFilePreview } from './remote-file-preview.ts';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, expect, it, onTestFailed } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-present/types';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { checkChildLifecycle, checkCrossWorldInspection } from './remote-children.ts';
import { prepareReplay } from './remote-replay.ts';
import { newEnglishPage } from './support.ts';

const root = process.env.DSH_REMOTE_ROOT!;
const state = process.env.DSH_REMOTE_STATE!;
let scaffold: WebScaffold | undefined;
let browser: Browser | undefined;
const browserErrors: string[] = [];
let replay: Awaited<ReturnType<typeof prepareReplay>> | undefined;
afterAll(async () => { try { await browser?.close(); await scaffold?.close(); } finally { await replay?.close(); } });
it('keeps portable workspaces isolated across the Web lifecycle and failures', async () => {
  replay = await prepareReplay(state);
  const key = credentialRef('DSH_REMOTE_SEARCH_TEST');
  const launch = (providersOnly = false) => launchWebScaffold({ extraOverlayPath: `${process.env.DSH_TEST_EXTENSION}/cordis.patch.yml`,
    extraInstallAnchors: [`${process.env.DSH_TEST_EXTENSION}/package.json`],
    compareReplaySession: false, ...(providersOnly ? {} : {
      replayFixture: new URL('../../../snapshots/web/web-search-round/session.v2.jsonl', import.meta.url).pathname, replayOverride: replay.override, replayChildFixtures: replay.childFixtures }), deepSeekSearch: { baseURL: replay.baseURL, apiKeyEnv: key },
    directoryPicking: false, persistentStateRoot: state, harnessHome: `${state}/home`,
    agentPresets: { default: 'remote', roots: [{ path: `${process.env.DSH_TEST_EXTENSION}/presets`, trust: 'system' }] }, toolsMode: 'native' });
  scaffold = await launch();
  await expect(scaffold.ctx.get('sessionController').openWorkspacePath({ path: '/workspace' }, new AbortController().signal)).rejects.toThrow('Native workspace opening is disabled');
  await expect(scaffold.ctx.get('sessionController').openWorkspacePath({ path: '/workspace', action: 'reveal' }, new AbortController().signal)).rejects.toThrow('Native workspace opening is disabled');
  await scaffold.ctx.credentials.set(key, 'local-connector-fixture');
  browser = await chromium.launch({ headless: true });
  let page = await openPage(browser);
  onTestFailed(async () => { if (page.isClosed()) return; console.error('PAGE', await page.locator('body').innerText()); await page.screenshot({ path: `${root}/artifacts/dsh/web-failure.png`, fullPage: true }); });
  await page.goto(scaffold.authenticatedUrl);
  const choose = async (index: number) => {
    await page.getByRole('button', { name: 'New session', exact: true }).last().click();
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('menuitem').filter({ hasText: '/workspace' }).nth(index).click();
  };
  await choose(0);
  await expect.poll(() => scaffold!.ctx.agents.list().length, { timeout: 30000 }).toBe(1);
  await choose(1);
  await expect.poll(() => scaffold!.ctx.agents.list().length, { timeout: 30000 }).toBe(2);
  expect(await page.locator('.session-card').count()).toBe(0);
  for (const agent of scaffold.ctx.agents.list()) await recordConversation(scaffold.ctx, agent);
  await expect.poll(() => page.locator('.session-card').count()).toBe(2);
  const cardFor = (id: string) => page.getByRole('button', { name: `Open session ${id}`, exact: true });
  await expect.poll(() => cardFor(scaffold!.ctx.agents.list()[0]!.session.header.id).locator('svg').first().getAttribute('stroke')).toBe('#a855f7');
  await page.screenshot({ path: `${root}/artifacts/dsh/web-sidebar-cards.png`, fullPage: true });
  await page.locator('.portable-workspaces').screenshot({ path: `${root}/artifacts/dsh/sidebar-cards.png` });
  const first = scaffold.ctx.agents.list()[0]!;
  await checkFilePreview(scaffold, page, first, scaffold.ctx.agents.list()[1]!);
  const catalogA = await scaffold.ctx.get('sessionSkillCatalog').list({ sessionId: first.session.header.id }, new AbortController().signal);
  const catalogB = await scaffold.ctx.get('sessionSkillCatalog').list({ sessionId: scaffold.ctx.agents.list()[1]!.session.header.id }, new AbortController().signal);
  expect(catalogA.skills.map(skill => skill.name)).toEqual(['remote-proof', 'world-a']);
  expect(catalogB.skills.map(skill => skill.name)).toEqual(['remote-proof', 'world-b']);
  await page.getByRole('button', { name: `Open session ${first.session.header.id}`, exact: true }).click();
  const settled = waitForTurn(first.session.header.id);
  const input = page.locator('[data-composer-input][contenteditable=true]').first();
  await input.fill('@only-a');
  await page.getByRole('option', { name: /only-a\.txt/ }).click();
  await expect.poll(() => input.innerText()).toContain('only-a.txt');
  const results: Extract<SessionEvent, { type: 'tool/result' }>[] = [];
  const deliveries: Extract<SessionEvent, { type: 'deliverables/presented' }>[] = [];
  scaffold.ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') results.push(event);
    if (event.type === 'deliverables/presented') deliveries.push(event);
  });
  await input.fill('Exercise the remote workspace and the local search connector.');
  await input.press('Enter');
  await settled;
  const preview = page.getByRole('img', { name: 'Remote preview', exact: true }).first();
  await expect.poll(() => preview.getAttribute('src')).toContain(`sessionId=${first.session.header.id}`);
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(13);
  await page.getByText('coding-0.txt', { exact: true }).filter({ visible: true }).first().click();
  await expect.poll(() => page.locator('[data-textpreview-body]').innerText()).toContain('after');
  expect(results).toHaveLength(18);
  for (const result of results) expect(result.data.message.content, JSON.stringify(result)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false })]));
  const history = JSON.stringify(first.session.surface.nodes.map(seq => first.session.eventAt(seq)));
  const delivery = deliveries[0];
  expect(delivery?.data).toMatchObject({ files: [{ path: 'coding-0.txt' }, { path: '/tmp/dsh-present.txt' }, { path: '/tmp/dsh-preview.html' }, { path: '/tmp/dsh-preview.pdf' }, { path: '/workspace/preview.svg' }] });
  const delivered = page.locator('[data-presented-files-row]').last();
  await delivered.getByRole('button', { name: 'Open /tmp/dsh-present.txt in sidebar', exact: true }).click();
  await expect.poll(() => page.locator('[data-document-preview]:visible [data-textpreview-body]').innerText()).toContain('OUTSIDE_WORLD_A');
  await delivered.getByRole('button', { name: 'Open /tmp/dsh-preview.html in sidebar', exact: true }).click();
  const html = page.frameLocator('[data-html-preview]:visible');
  await expect.poll(() => html.locator('#proof').innerText()).toBe('REMOTE_HTML_A');
  await expect.poll(() => html.locator('#proof').evaluate(element => getComputedStyle(element).color)).toBe('rgb(12, 34, 56)');
  await delivered.getByRole('button', { name: 'Open /tmp/dsh-preview.pdf in sidebar', exact: true }).click();
  const canvas = page.locator('[data-pdf-preview]:visible canvas').first();
  await expect.poll(() => canvas.evaluate(element => Array.from((element as HTMLCanvasElement).getContext('2d')!.getImageData(5, 5, 1, 1).data))).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: 'Show all 5 delivered files', exact: true }).click();
  await delivered.getByRole('button', { name: 'Open /workspace/preview.svg in sidebar', exact: true }).click();
  await expect.poll(() => page.locator('[data-image-preview]:visible img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(13);
  expect((await page.request.get(new URL('/api/present.host', page.url()).href)).ok()).toBe(true);
  for (const action of ['open', 'reveal']) {
    const endpoint = new URL('/api/present.open', page.url());
    endpoint.search = new URLSearchParams({ sessionId: first.session.header.id, seq: String(delivery!.seq), index: '1', action }).toString();
    expect((await page.request.post(endpoint.href)).status()).toBe(409);
  }
  expect(history).toContain('WORLD_INSTRUCTIONS_A');
  expect(history).toContain('NESTED_WORLD_INSTRUCTIONS');
  expect(history).not.toContain('WORLD_INSTRUCTIONS_B');
  expect(history).toContain('skill-catalog');
  expect(history).toContain('skill-executed-in-a');
  expect(history).toContain('REMOTE_CHILD_DONE');
  expect(replay.requests).toHaveLength(1);
  expect(replay.requests[0]).toMatchObject({ url: '/messages', key: 'local-connector-fixture' });
  const owner = scaffold.ctx.get('executionWorlds').forAgent(first);
  expect(await owner.fs.readText(await owner.fs.resolve('browser-proof.txt'))).toBe('browser-proof');
  expect(await owner.fs.readText(await owner.fs.resolve('coding-0.txt'))).toBe('after\n');
  const second = scaffold.ctx.agents.list()[1]!;
  const other = scaffold.ctx.get('executionWorlds').forAgent(second);
  expect(await scaffold.ctx.get('fileReferences').list(second, 'only-', new AbortController().signal)).toEqual([{ path: 'only-b.txt', kind: 'file' }]);
  expect(scaffold.ctx.get('jobs').list(second)).toEqual([]);
  await stopBackground(first);
  expect(await owner.fs.readText(await owner.fs.resolve('child-proof.txt'))).toBe('child-proof');
  expect(await other.fs.stat(await other.fs.resolve('child-proof.txt'))).toBeUndefined();
  await checkTerminal(first, second);
  const childHeader = (await scaffold.ctx.sessionPersistence.list()).find(row => row.header.origin === 'subagent' && row.header.parentSession === first.session.header.id)!.header;
  expect(scaffold.ctx.get('worldPortableWorkspaces').forSession(childHeader.id)).toBeUndefined();
  const childCatalog = await scaffold.ctx.get('sessionSkillCatalog').list({ sessionId: childHeader.id }, new AbortController().signal);
  expect(childCatalog.skills.map(skill => skill.name)).toEqual(['remote-proof', 'world-a']);
  expect(() => first.session.append('sandbox/mode', { mode: 'read-only' })).toThrow('remote sandbox modes are not available');
  expect(scaffold.ctx.get('sandboxPolicy').resolve({ session: first.session }).mode).toBe('danger-full-access');
  expect(await other.fs.stat(await other.fs.resolve('browser-proof.txt'))).toBeUndefined();
  expect(await other.fs.stat(await other.fs.resolve('coding-0.txt'))).toBeUndefined();
  await other.fs.writeText(await other.fs.resolve('.agents/skills/world-skill/SKILL.md'), '---\nname: world-b\ndescription: Updated remote catalog.\n---\nUpdated');
  const refreshed = await scaffold.ctx.get('sessionSkillCatalog').list({ sessionId: second.session.header.id }, new AbortController().signal);
  expect(refreshed.skills.find(skill => skill.name === 'world-b')?.description).toBe('Updated remote catalog.');
  await page.screenshot({ path: `${root}/artifacts/dsh/web-remote-round.png`, fullPage: true });
  const sessionId = first.session.header.id;
  await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click();
  await expect.poll(() => scaffold!.ctx.agents.list().find(agent => agent.session.header.parentSession === sessionId), { timeout: 15000 }).toBeDefined();
  const fork = scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === sessionId)!;
  expect(scaffold.ctx.sessionProjections.snapshot(fork.session).values.subagentCatalog).toEqual([]);
  await expect.poll(() => cardFor(fork.session.header.id).locator('svg').first().getAttribute('stroke')).toBe('#a855f7');
  expect(scaffold.ctx.get('executionWorlds').bindings.get(fork.session.header.id)).toEqual(scaffold.ctx.get('executionWorlds').bindings.get(sessionId));
  await page.getByRole('button', { name: `Open session ${sessionId}`, exact: true }).click();
  await cardFor(fork.session.header.id).hover();
  await page.getByRole('button', { name: `Archive session ${fork.session.header.id}`, exact: true }).click();
  await expect.poll(() => page.getByRole('button', { name: `Open session ${fork.session.header.id}`, exact: true }).count()).toBe(0);
  const registry = scaffold.ctx.get('worldPortableWorkspaces');
  const workspaceA = registry.forSession(first.session.header.id)!;
  const workspaceB = registry.forSession(second.session.header.id)!;
  await workspaceA.setTitle('World A renamed');
  await registry.insertBefore(workspaceA.id);
  expect(registry.list()[1]?.title).toBe('World A renamed');
  await registry.insertBefore(workspaceA.id, workspaceB.id);
  expect(registry.list()[0]?.title).toBe('World A renamed');
  await registry.delete(workspaceB.id);
  expect(registry.list().length).toBe(1);
  expect(await other.fs.readText(await other.fs.resolve('world.txt'))).toBe('b\n');
  await choose(1);
  await expect.poll(() => registry.list().length).toBe(2);
  expect(registry.forSession(second.session.header.id)).toBeDefined();
  await page.getByRole('button', { name: `Open session ${sessionId}`, exact: true }).click();
  await page.screenshot({ path: `${root}/artifacts/dsh/web-management.png`, fullPage: true });
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(sessionId);
  const deepLink = new URL(page.url());
  const oldRuntime = owner.remoteWorld.client.info.runtime;
  const savedSecondBinding = scaffold.ctx.get('executionWorlds').bindings.get(second.session.header.id);
  expect(savedSecondBinding).toBeDefined();
  await page.close();
  await scaffold.close();
  await replay.roundScript();
  scaffold = await launch();
  const coldWorkspaceB = scaffold.ctx.get('worldPortableWorkspaces').forSession(second.session.header.id)!;
  expect(coldWorkspaceB).toBeDefined();
  await scaffold.ctx.get('sessionController').create({ sessionId: second.session.header.id, workspaceId: coldWorkspaceB.id });
  const coldSecond = scaffold.ctx.agents.get(second.session.header.id)!;
  expect(coldSecond).toBeDefined();
  expect(scaffold.ctx.get('executionWorlds').bindings.get(coldSecond.id)).toEqual(savedSecondBinding);
  const coldOwnerB = scaffold.ctx.get('executionWorlds').forAgent(coldSecond);
  expect(await coldOwnerB.fs.readText(await coldOwnerB.fs.resolve('world.txt'))).toBe('b\n');
  expect(scaffold.ctx.agents.get(sessionId)).toBeUndefined();
  const coldScope = { sessionId, workspaceRoot: '/workspace' };
  expect((await scaffold.ctx.get('workspaceFiles').read(coldScope, '/tmp/dsh-present.txt', {}, AbortSignal.timeout(15000))).text).toBe('OUTSIDE_WORLD_A');
  expect((await scaffold.ctx.get('workspaceFiles').read({ sessionId: childHeader.id, workspaceRoot: '/workspace' }, 'world.txt', {}, AbortSignal.timeout(15000))).text).toBe('a');
  expect(scaffold.ctx.agents.get(sessionId)).toBeUndefined();
  expect(scaffold.ctx.agents.get(childHeader.id)).toBeUndefined();
  const coldCatalog = await scaffold.ctx.get('sessionSkillCatalog').list({ sessionId }, new AbortController().signal);
  expect(coldCatalog.skills.map(skill => skill.name)).toEqual(['remote-proof', 'world-a']);
  expect(scaffold.ctx.agents.get(sessionId)).toBeUndefined();
  page = await openPage(browser);
  await page.goto(scaffold.authenticatedUrl);
  await page.goto(new URL(deepLink.pathname + deepLink.search + deepLink.hash, scaffold.baseUrl).href);
  // Reopening World B reuses its existing Session after a current-format cold restore.
  await expect.poll(() => page.locator('.session-card').count(), { timeout: 15000 }).toBe(2);
  await expect.poll(() => cardFor(second.session.header.id).count()).toBe(1);
  expect(await cardFor(fork.session.header.id).count()).toBe(0);
  await expect.poll(() => cardFor(sessionId).locator('svg').first().getAttribute('stroke')).toBe('#a855f7');
  const coldSettled = waitForTurn(sessionId);
  results.length = 0;
  scaffold.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event); });
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('Continue in the saved World.');
  await page.locator('[data-composer-input][contenteditable=true]').first().press('Enter');
  expect(await coldSettled).toBe(sessionId);
  expect(results).toHaveLength(18);
  for (const result of results) expect(result.data.message.content, JSON.stringify(result)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false })]));
  const resumed = scaffold.ctx.agents.get(sessionId)!;
  expect(scaffold.ctx.get('sandboxPolicy').resolve({ session: resumed.session }).mode).toBe('danger-full-access');
  const resumedOwner = scaffold.ctx.get('executionWorlds').forAgent(resumed);
  expect(resumedOwner.remoteWorld.client.info.runtime).not.toBe(oldRuntime);
  expect(await resumedOwner.fs.readText(await resumedOwner.fs.resolve('world.txt'))).toBe('a\n');
  expect(replay.requests).toHaveLength(2);
  await stopBackground(resumed);
  await page.close();
  await scaffold.close();
  await replay.cancelScript();
  scaffold = await launch();
  page = await openPage(browser);
  await page.goto(scaffold.authenticatedUrl);
  await page.goto(new URL(deepLink.pathname + deepLink.search + deepLink.hash, scaffold.baseUrl).href);
  const canceled = waitForTurn(sessionId);
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('Start the cancellable remote command.');
  await page.locator('[data-composer-input][contenteditable=true]').first().press('Enter');
  await expect.poll(async () => {
    const agent = scaffold!.ctx.agents.get(sessionId);
    if (!agent) return false;
    const world = scaffold!.ctx.get('executionWorlds').forAgent(agent);
    return !!await world.fs.stat(await world.fs.resolve('cancel.started'));
  }, { timeout: 20000 }).toBe(true);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  expect(await canceled).toBe(sessionId);
  const cancelOwner = scaffold.ctx.get('executionWorlds').forAgent(scaffold.ctx.agents.get(sessionId)!);
  expect(await cancelOwner.fs.stat(await cancelOwner.fs.resolve('cancel.finished'))).toBeUndefined();
  const pid = (await cancelOwner.fs.readText(await cancelOwner.fs.resolve('cancel.pid'))).trim();
  expect(pid).toMatch(/^\d+$/);
  const probe = cancelOwner.subprocess.spawn({ argv: ['bash', '-c', 'kill -0 "$1" 2>/dev/null', 'probe', pid], cwd: '/workspace',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
  expect((await probe.done).exitCode).not.toBe(0);
  await probe.waitForExit();
  await page.screenshot({ path: `${root}/artifacts/dsh/web-cold-cancel.png`, fullPage: true });
  await page.close();
  await scaffold.close();
  await checkChildLifecycle(async () => { scaffold = await launch(true); return scaffold; }, sessionId, second.session.header.id, { provider: first.options.provider!, model: first.options.model! });
  await checkCrossWorldInspection(async () => { scaffold = await launch(true); return scaffold; }, browser, { provider: first.options.provider!, model: first.options.model! });
  const bindingFile = `${state}/bindings.json`;
  const bindings = JSON.parse(await readFile(bindingFile, 'utf8'));
  bindings.sessions = bindings.sessions.filter((entry: { sessionId: string }) => entry.sessionId !== sessionId);
  await writeFile(bindingFile, JSON.stringify(bindings), { mode: 0o600 });
  scaffold = await launch(true);
  await expect(scaffold.ctx.get('sessionSkillCatalog').list({ sessionId }, new AbortController().signal)).rejects.toThrow('saved Session membership');
  await expect(scaffold.ctx.get('workspaceFiles').readAll({ sessionId, workspaceRoot: '/workspace' }, '/tmp/dsh-present.txt', AbortSignal.timeout(15000))).rejects.toMatchObject({ code: 'WORLD_REQUIRED' });
  page = await openPage(browser);
  await page.goto(scaffold.authenticatedUrl);
  await page.goto(new URL(deepLink.pathname + deepLink.search + deepLink.hash, scaffold.baseUrl).href);
  const refusal = page.waitForResponse(response => response.request().postData()?.includes('This must fail without a saved binding.') ?? false);
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('This must fail without a saved binding.');
  await page.locator('[data-composer-input][contenteditable=true]').first().press('Enter');
  expect(await (await refusal).text()).toMatch(/saved Session membership/);
  await expect.poll(() => page.locator('body').innerText(), { timeout: 15000 }).toMatch(/WORLD_REQUIRED|Session admission failed|saved Session membership/);
  expect(scaffold.ctx.agents.get(sessionId)).toBeUndefined();
  expect(scaffold.ctx.get('executionWorlds').bindings.get(sessionId)).toBeUndefined();
  await page.screenshot({ path: `${root}/artifacts/dsh/web-missing-binding.png`, fullPage: true });
  const containers = JSON.parse(process.env.DSH_TEST_WORLD_CONTAINERS!);
  execFileSync('docker', ['stop', containers.b], { stdio: 'ignore' });
  const secondId = second.session.header.id;
  await page.getByRole('button', { name: `Open session ${secondId}`, exact: true }).click();
  const unavailable = page.waitForResponse(response => response.request().postData()?.includes('This must fail for an unavailable World.') ?? false);
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('This must fail for an unavailable World.');
  await page.locator('[data-composer-input][contenteditable=true]').first().press('Enter');
  expect(await (await unavailable).text()).toMatch(/Remote control command failed/);
  expect(scaffold.ctx.agents.get(secondId)).toBeUndefined();
  expect(scaffold.ctx.get('executionWorlds').bindings.get(secondId)).toBeDefined();
  expect(browserErrors).toEqual([]);
});

async function openPage(browser: Browser): Promise<Page> {
  const page = await newEnglishPage(browser);
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) { console.error('CONSOLE', message.text()); if (message.text().includes('event feed subscriber failed')) browserErrors.push(message.text()); } });
  page.on('pageerror', error => { browserErrors.push(String(error)); console.error('BROWSER', error); });
  return page;
}

async function stopBackground(agent: Agent) {
  const jobs = scaffold!.ctx.get('jobs');
  const job = jobs.list(agent)[0]!;
  expect(job).toBeDefined();
  if (job.status !== 'running') console.error('BACKGROUND', job, jobs.read(job.id, agent));
  const owner = scaffold!.ctx.get('executionWorlds').forAgent(agent);
  await expect.poll(async () => !!await owner.fs.stat(await owner.fs.resolve('background.started'))).toBe(true);
  const result = await scaffold!.ctx.tools.execute({ name: 'job_kill', arguments: { job_id: job.id }, agent,
    callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(15000) });
  expect(result.isError).not.toBe(true);
  await expect.poll(() => jobs.get(job.id, agent).status).toBe('killed');
  expect(await owner.fs.stat(await owner.fs.resolve('background.finished'))).toBeUndefined();
}

async function checkTerminal(agent: Agent, other: Agent) {
  const terminals = scaffold!.ctx.get('agentPresets').serviceFor(agent, 'terminals')!;
  const terminal = await terminals.spawn(agent, { type: 'shell', name: 'remote-acceptance' }, AbortSignal.timeout(15000));
  const sent = await scaffold!.ctx.tools.execute({ name: 'terminal_send', arguments: { sessionId: terminal.sessionId, text: 'printf terminal-proof > terminal-proof.txt' }, agent,
    callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(15000) });
  expect(sent.isError).not.toBe(true);
  const owner = scaffold!.ctx.get('executionWorlds').forAgent(agent);
  expect(await owner.fs.readText(await owner.fs.resolve('terminal-proof.txt'))).toBe('terminal-proof');
  expect(scaffold!.ctx.get('agentPresets').serviceFor(other, 'terminals')!.list(other)).toEqual([]);
  const rejected = await scaffold!.ctx.tools.execute({ name: 'terminal_send', arguments: { sessionId: terminal.sessionId, text: 'touch wrong-world' }, agent: other,
    callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(15000) });
  expect(rejected.isError).toBe(true);
  const closed = await scaffold!.ctx.tools.execute({ name: 'terminal_close', arguments: { sessionId: terminal.sessionId }, agent,
    callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(15000) });
  expect(closed.isError).not.toBe(true);
}

function waitForTurn(sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Parent turn did not settle')); }, 30000);
    const off = scaffold!.ctx.on('session/event', (session, event) => {
      if (session.header.id !== sessionId || event.type !== 'turn/end') return;
      clearTimeout(timer); off();
      scaffold!.ctx.sessions.flush(session).then(() => resolve(sessionId), reject);
    });
  });
}
