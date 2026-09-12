import { afterAll, expect, it, onTestFailed } from 'vitest';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';

const root = process.env.DSH_REMOTE_ROOT!;
const state = process.env.DSH_REMOTE_STATE!;
const home = join(state, 'home');
const project = join(state, 'project');
const extension = process.env.DSH_TEST_EXTENSION!;
let host: WebScaffold | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
afterAll(async () => { await browser?.close(); await host?.close(); });

const launch = (installed: boolean) => launchWebScaffold({
  ...(installed ? { extraOverlayPath: `${extension}/cordis.patch.yml`, extraInstallAnchors: [`${extension}/package.json`] } : {}),
  compareReplaySession: false, directoryPicking: true, persistentStateRoot: state, harnessHome: home, toolsMode: 'native',
});
const tool = (agent: Agent, name: string, args: unknown) => host!.ctx.tools.execute({
  agent, name, arguments: args, callId: ToolCallId(randomUUID()), signal: AbortSignal.timeout(30000),
});
async function localOperations(agent: Agent, suffix: string) {
  const read = await tool(agent, 'read', { file_path: 'world.txt' });
  expect(read.isError, JSON.stringify(read)).toBe(false);
  expect(JSON.stringify(read)).toContain('LOCAL_WORLD');
  const written = await tool(agent, 'write', { file_path: `${suffix}.txt`, content: `LOCAL_${suffix}` });
  expect(written.isError, JSON.stringify(written)).toBe(false);
  expect(await readFile(join(project, `${suffix}.txt`), 'utf8')).toBe(`LOCAL_${suffix}`);
  const policy = host!.ctx.get('sandboxPolicy').resolve({ session: agent.session });
  expect(policy).toMatchObject({ mode: 'workspace-write', workspaceRoot: project });
  const outside = await tool(agent, 'write', { file_path: join(state, `outside-${suffix}.txt`), content: 'must not write' });
  expect(outside.isError).toBe(true);
  await expect(access(join(state, `outside-${suffix}.txt`))).rejects.toThrow();
  const shell = await tool(agent, 'bash', { command: `printf LOCAL_SHELL > shell-${suffix}.txt; pwd`, description: 'Verify native local shell' });
  expect(shell.isError, JSON.stringify(shell)).toBe(false);
  expect(await readFile(join(project, `shell-${suffix}.txt`), 'utf8')).toBe('LOCAL_SHELL');
}
async function turn(agent: Agent, text: string) {
  const adapter = new MockAdapter([textResponse(text)]);
  const provider = `local-fixture-${randomUUID()}`;
  host!.ctx.llm.registerAdapter([provider], adapter);
  await host!.ctx.get('sessionController').selectModel({ sessionId: agent.id, provider, model: 'fixture' });
  const done = host!.whenTurnSettled();
  await host!.ctx.get('sessionController').prompt({ sessionId: agent.id, requestId: brandString<SessionRequestId>(randomUUID()), mode: 'queue', content: [{ type: 'text', text: 'Verify this workspace.' }] }, AbortSignal.timeout(30000));
  await done;
  return adapter;
}

it('preserves native macOS workspaces and permissions when the standard extension is installed', async () => {
  await mkdir(project, { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await writeFile(join(project, 'world.txt'), 'LOCAL_WORLD');
  await writeFile(join(project, 'AGENTS.md'), 'LOCAL_PROJECT_INSTRUCTIONS');
  await mkdir(join(project, '.agents/skills/local-proof'), { recursive: true });
  await writeFile(join(project, '.agents/skills/local-proof/SKILL.md'), '---\nname: local-proof\ndescription: Local fixture\n---\nLOCAL_SKILL_CONTENT\n');

  // Unchanged official host, native standard preset and native registry establish the local baseline.
  host = await launch(false);
  const nativeWorkspace = await host.ctx.get('workspaceRegistry').create(project);
  const created = await host.ctx.get('sessionController').create({ workspaceId: nativeWorkspace.id });
  const historicalId = created.sessionId;
  let originalId = historicalId;
  const original = host.ctx.agents.get(originalId)!;
  expect(original.session.header.agentPreset).toBe('standard');
  await localOperations(original, 'vanilla');
  const nativeSkills = await host.ctx.get('sessionSkillCatalog').list({ sessionId: originalId }, AbortSignal.timeout(10000));
  expect(nativeSkills.skills.map(skill => skill.name)).toContain('local-proof');
  await turn(original, 'VANILLA_DONE');
  await host.close(); host = undefined;
  const logs = new Map<string, Buffer>();
  async function remember(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await remember(path); else logs.set(path, await readFile(path));
    }
  }
  await remember(join(state, 'sessions'));

  // No SSH target, no usable runtime manifest or download cache. Local admission cannot bootstrap.
  const { BindingStore } = await import(`${extension}/bindings.js`);
  await mkdir(join(home, 'remote'), { recursive: true, mode: 0o700 });
  const bindingFile = join(home, 'remote/bindings.json');
  BindingStore.create(bindingFile);
  await writeFile(join(home, 'remote/config.json'), JSON.stringify({ worlds: [], bindingFile, bootstrap: { manifest: { deliberatelyInvalid: true }, cacheDir: join(state, 'must-not-download') } }));
  const worldsFile = join(home, 'remote/worlds.json');
  await writeFile(worldsFile, JSON.stringify({ worlds: [] }));
  host = await launch(true);
  for (const [path, bytes] of logs) expect(await readFile(path)).toEqual(bytes);
  const worlds = host.ctx.get('executionWorlds');
  const registry = host.ctx.get('worldPortableWorkspaces');
  // Existing unbound history is retained but never implicitly granted execution authority.
  expect(worlds.bindings.get(historicalId)).toBeUndefined();
  expect(registry.forSession(historicalId)).toBeUndefined();
  await expect(host.ctx.get('sessionController').create({ sessionId: historicalId, workspaceId: nativeWorkspace.id })).rejects.toThrow('no saved World binding');
  expect(JSON.parse(await readFile(bindingFile, 'utf8')).version).toBe(3);
  expect((await readdir(join(home, 'remote'))).filter(name => name.endsWith('.bak'))).toHaveLength(0);
  await expect(access(join(state, 'must-not-download'))).rejects.toThrow();

  const admitted = await host.ctx.get('sessionController').create({ workspaceId: nativeWorkspace.id });
  originalId = admitted.sessionId;
  const resumed = host.ctx.agents.get(originalId)!;
  expect(worlds.bindings.get(originalId)).toMatchObject({ kind: 'local', worldId: 'local', cwd: project });
  expect(registry.forSession(originalId).id).toBe(nativeWorkspace.id);
  await expect(registry.get(nativeWorkspace.id).detachSession(originalId)).rejects.toThrow('membership is immutable');
  await localOperations(resumed, 'installed');
  expect(worlds.forAgent(resumed).get('remoteWorld')).toBeUndefined();
  const skills = await host.ctx.get('sessionSkillCatalog').list({ sessionId: originalId }, AbortSignal.timeout(10000));
  expect(skills.skills.map(skill => skill.name)).toContain('local-proof');
  const adapter = await turn(resumed, 'INSTALLED_LOCAL_DONE');
  expect(JSON.stringify(adapter.requests)).toContain('LOCAL_PROJECT_INSTRUCTIONS');
  expect(JSON.stringify(adapter.requests)).toContain('local-proof');
  expect(JSON.stringify(adapter.requests)).not.toContain('helperBuild');
  for (const fact of ['"world":"local"', '"workspace":"workspace:']) {
    expect(JSON.stringify(adapter.requests)).toContain(JSON.stringify(fact).slice(1, -1));
  }
  const fileReferences = await host.ctx.get('fileReferences').list(resumed, 'world', AbortSignal.timeout(10000));
  expect(fileReferences.map(row => row.path)).toContain('world.txt');

  // Native policy events remain available and enforced, while changing the execution preset rejects.
  resumed.session.append('sandbox/mode', { mode: 'read-only' });
  expect((await tool(resumed, 'write', { file_path: 'read-only-denied.txt', content: 'no' })).isError).toBe(true);
  resumed.session.append('sandbox/mode', { mode: 'workspace-write' });
  const fresh = await host.ctx.get('sessionController').create({ workspaceId: nativeWorkspace.id });
  const freshAgent = host.ctx.agents.get(fresh.sessionId)!;
  await expect(host.ctx.get('agentPresets').select(freshAgent, 'remote')).rejects.toThrow('execution environment');
  expect(host.ctx.get('agentPresets').composedPreset(freshAgent.ctx)).toBe('standard');

  console.log('LOCAL acceptance: jobs');
  const jobs = host.ctx.get('jobs');
  expect((await tool(resumed, 'bash', { command: 'touch local-job.started; sleep 60; touch local-job.finished', description: 'Local background job', run_in_background: true })).isError).toBe(false);
  const job = jobs.list(resumed)[0]!;
  await expect.poll(async () => { try { await access(join(project, 'local-job.started')); return true; } catch { return false; } }).toBe(true);
  expect(jobs.list(freshAgent)).toEqual([]);
  expect((await tool(resumed, 'job_kill', { job_id: job.id })).isError).toBe(false);
  await expect.poll(() => jobs.get(job.id, resumed).status).toBe('killed');
  await expect(access(join(project, 'local-job.finished'))).rejects.toThrow();
  console.log('LOCAL acceptance: terminals');
  const terminals = host.ctx.get('agentPresets').serviceFor(resumed, 'terminals')!;
  const terminal = await terminals.spawn(resumed, { type: 'shell', name: 'native-local' }, AbortSignal.timeout(15000));
  expect((await tool(resumed, 'terminal_send', { sessionId: terminal.sessionId, text: 'printf LOCAL_TERMINAL > local-terminal.txt' })).isError).toBe(false);
  expect(await readFile(join(project, 'local-terminal.txt'), 'utf8')).toBe('LOCAL_TERMINAL');
  expect((await tool(freshAgent, 'terminal_send', { sessionId: terminal.sessionId, text: 'touch wrong-session' })).isError).toBe(true);
  expect((await tool(resumed, 'terminal_close', { sessionId: terminal.sessionId })).isError).toBe(false);

  console.log('LOCAL acceptance: child');
  let childCalls = 0;
  const childAdapter = new MockAdapter(Array.from({ length: 8 }, () => request => request.sessionId === originalId
    ? textResponse('LOCAL_PARENT_DONE') : [toolCallResponse('local-child-read', 'read', { file_path: 'world.txt' }), textResponse('LOCAL_CHILD_DONE')][childCalls++] ?? textResponse('DONE')));
  host.ctx.llm.registerAdapter(['local-child'], childAdapter);
  const child = await host.ctx.get('subagents').startContinuable({ provider: 'spawn', label: 'Local child', request: {
    parent: resumed, agentOptions: { provider: 'local-child', model: 'fixture' }, prompt: [{ type: 'text', text: 'Read the local marker.' }], toolFilter: { allow: ['read'] },
  }, signal: AbortSignal.timeout(15000) });
  await expect.poll(() => childCalls).toBe(2);
  await expect.poll(() => host!.ctx.agents.get(child.childId)).toBeUndefined();
  expect(worlds.bindings.get(child.childId)).toEqual(worlds.bindings.get(originalId));
  expect((await registry.contextForSession(child.childId)).id).toBe(nativeWorkspace.id);
  expect(JSON.stringify(childAdapter.requests)).toContain('LOCAL_WORLD');

  console.log('LOCAL acceptance: attachment store');
  const store = host.ctx.get('attachments').forSession(originalId);
  const ref = await store.saveFile({ data: Buffer.from('LOCAL_ATTACHMENT'), name: 'local-note.txt' });
  expect(ref.attachmentId).not.toContain('@world-');
  expect(store.fileExecutionPath(ref)).toBeUndefined();
  expect(await readFile(store.fileHostPath(ref)!, 'utf8')).toBe('LOCAL_ATTACHMENT');
  const chunks = [];
  for await (const chunk of store.readFileStream(ref)) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('LOCAL_ATTACHMENT');

  const fork = await host.ctx.get('sessionController').fork({ sessionId: originalId });
  expect(worlds.bindings.get(fork.sessionId)).toEqual(worlds.bindings.get(originalId));
  expect(host.ctx.agents.get(fork.sessionId)!.session.header.agentPreset).toBe('standard');
  expect((await tool(host.ctx.agents.get(fork.sessionId)!, 'read', { file_path: 'world.txt' })).isError).toBe(false);

  console.log('LOCAL acceptance: browser');
  browser = await chromium.launch({ headless: true });
  page = await newEnglishPage(browser);
  page.on('pageerror', error => console.error('Browser error:', error));
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  onTestFailed(async () => { if (page && !page.isClosed()) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: `${root}/artifacts/dsh/local-workspace-failure.png` }); } });
  await page.goto(host.authenticatedUrl);
  await page.getByRole('button', { name: `Open session ${originalId}`, exact: true }).click();
  const peer = await newEnglishPage(browser);
  try {
    await peer.goto(host.authenticatedUrl);
    await peer.getByRole('button', { name: `Open session ${originalId}`, exact: true }).waitFor();
    const beforePreference = registry.get(nativeWorkspace.id).updatedAt;
    await registry.pinSession(originalId, true);
    for (const client of [page, peer]) {
      await expect.poll(() => client.getByRole('button', { name: `Unpin session ${originalId}`, exact: true }).count()).toBe(1);
    }
    await peer.getByRole('button', { name: `Unpin session ${originalId}`, exact: true }).click();
    for (const client of [page, peer]) {
      await expect.poll(() => client.getByRole('button', { name: `Pin session ${originalId}`, exact: true }).count()).toBe(1);
    }
    expect(registry.get(nativeWorkspace.id).updatedAt).toBe(beforePreference);
  } finally { await peer.close(); }

  let uploadedFile: FileAttachmentRef | undefined, uploadedImage: ImageAttachmentRef | undefined;
  const uploadResults: unknown[] = [];
  host.ctx.on('session/event', (session, event) => {
    if (session.id !== originalId) return;
    if (event.type === 'user/message') for (const block of event.data.content) {
      if (block.type === 'file') uploadedFile = block.attachment;
      if (block.type === 'image') uploadedImage = block.attachment;
    }
    if (event.type === 'tool/result') uploadResults.push(event.data);
  });
  class ImageAdapter extends MockAdapter {
    override async resolveModel(provider: string, model: string) { return { ...await super.resolveModel(provider, model), inputModalities: ['text', 'image'] as const }; }
  }
  console.log('LOCAL acceptance: upload');
  const uploadAdapter = new ImageAdapter([
    () => toolCallResponse('local-upload-read', 'read', { file_path: store.fileHostPath(uploadedFile!) }),
    () => toolCallResponse('local-upload-image', 'read_image', { file_path: store.imageHostPath(uploadedImage!) }),
    textResponse('LOCAL_UPLOAD_DONE'),
  ]);
  host.ctx.llm.registerAdapter(['local-upload'], uploadAdapter);
  await host.ctx.get('sessionController').selectModel({ sessionId: originalId, provider: 'local-upload', model: 'fixture' });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'native-note.txt', mimeType: 'text/plain', buffer: Buffer.from('NATIVE_UPLOAD_CONTENT') },
    { name: 'native-image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQYlWPQyPIkBjGMMHUAin9N2lOOmHUAAAAASUVORK5CYII=', 'base64') },
  ]);
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('Read both native attachments.');
  const send = page.getByRole('button', { name: 'Send message' });
  await expect.poll(() => send.isEnabled()).toBe(true);
  const uploaded = host.whenTurnSettled();
  await send.click(); await uploaded;
  expect(JSON.stringify(uploadResults)).toContain('NATIVE_UPLOAD_CONTENT');
  expect(JSON.stringify(uploadResults)).not.toContain('"isError":true');
  expect(uploadResults).toHaveLength(2);
  expect(uploadedImage!.attachmentId).not.toContain('@world-');
  expect(await host.ctx.get('attachments').forSession(child.childId).readImage(uploadedImage!)).toEqual(await store.readImage(uploadedImage!));
  const exported = await page.request.get(new URL(`/api/session.export?sessionId=${originalId}&includeDescendants=true`, page.url()).href);
  expect(exported.ok()).toBe(true);
  execFileSync('python3', ['-c', 'import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert any(z.read(n)==b"NATIVE_UPLOAD_CONTENT" for n in z.namelist()); assert any(n.endswith(".png") for n in z.namelist())'], { input: await exported.body() });
  await expect.poll(() => page!.getByRole('img', { name: 'native-image.png', exact: true }).first().evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(13);
  await page.getByRole('button', { name: 'New session', exact: true }).last().click();
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Choose a folder…', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Select Workspace Directory' });
  await chooser.waitFor();
  await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(host.ctx.agents.list()).toHaveLength(3);
  const selectedFolder = join(project, 'selected-from-browser');
  await mkdir(selectedFolder);
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Choose a folder…', exact: true }).click();
  await chooser.waitFor();
  await chooser.getByRole('button', { name: 'Edit path', exact: true }).click();
  await chooser.getByRole('textbox', { name: 'Edit path', exact: true }).fill(selectedFolder);
  await chooser.getByRole('textbox', { name: 'Edit path', exact: true }).press('Enter');
  await chooser.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => host!.ctx.agents.list().find(agent => agent.session.header.cwd === selectedFolder)).toBeDefined();
  expect(host.ctx.agents.list().find(agent => agent.session.header.cwd === selectedFolder)!.session.header.agentPreset).toBe('standard');
  const selectedAgent = host.ctx.agents.list().find(agent => agent.session.header.cwd === selectedFolder)!;
  expect(await page.getByRole('button', { name: `Open session ${selectedAgent.id}`, exact: true }).count()).toBe(0);
  // Exercise the generated RPC, not just the direct service call above: an
  // override parameter rename must not turn the admission error into a wire error.
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click();
  const remotePreset = page.getByRole('menuitem').filter({ hasText: 'SSH workspace' });
  expect(await remotePreset.innerText()).toContain('switching modes does not change where your session runs');
  await remotePreset.click();
  await page.getByText(/This session uses a local workspace/).waitFor();
  expect(await page.getByText(/unexpected "agentPreset"/).count()).toBe(0);
  expect(host.ctx.agents.list().find(agent => agent.session.header.cwd === selectedFolder)!.session.header.agentPreset).toBe('standard');
  await turn(selectedAgent, 'FIRST_MESSAGE_VISIBLE');
  await page.getByRole('button', { name: `Open session ${selectedAgent.id}`, exact: true }).waitFor();
  await turn(freshAgent, 'ANOTHER_CONVERSATION');
  await page.setViewportSize({ width: 1280, height: 300 });
  const list = page.locator('.portable-workspaces .session-list');
  await expect.poll(() => list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.hover();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page!.getByRole('button', { name: 'Reload worlds', exact: true }).isVisible()).toBe(true);
  await page.screenshot({ path: `${root}/artifacts/dsh/sidebar-scroll.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Reload worlds', exact: true }).click();
  const reloadDialog = page.getByRole('dialog', { name: 'Reload worlds', exact: true });
  await reloadDialog.waitFor();
  await reloadDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.screenshot({ path: `${root}/artifacts/dsh/local-workspace.png`, animations: 'disabled' });
  await browser.close(); browser = undefined; page = undefined;
  await host.close(); host = undefined;

  console.log('LOCAL acceptance: cold restore');
  host = await launch(true);
  expect(host.ctx.agents.list()).toHaveLength(0);
  const persistedImage = await host.ctx.get('sessionController').attachment({ sessionId: originalId, attachmentId: uploadedImage!.attachmentId });
  expect(persistedImage.data.length).toBeGreaterThan(0);
  const cold = await host.ctx.get('workspaceFileEnvironment').resolve(originalId, AbortSignal.timeout(10000));
  expect(await cold.fs.readText(await cold.fs.resolve(join(project, 'world.txt')))).toBe('LOCAL_WORLD');
  await host.ctx.get('sessionController').create({ sessionId: originalId, workspaceId: nativeWorkspace.id });
  expect((await tool(host.ctx.agents.get(originalId)!, 'read', { file_path: 'world.txt' })).isError).toBe(false);
  await expect(access(join(state, 'must-not-download'))).rejects.toThrow();
  await writeFile(`${root}/artifacts/dsh/local-workspace-result.json`, JSON.stringify({ status: 'passed', platform: process.platform, checks: ['vanilla baseline', 'unbound historical resume rejected; fresh explicit admission', 'local read/write and shell', 'native permission modes', 'native skills and instructions', 'background jobs and cancellation', 'terminal ownership', 'child binding and attachment reads', 'two-client presentation subscription without workspace mutation', 'browser uploads and model attachment reads', 'ZIP export with attachments', 'preset isolation', 'fork', 'directory picker cancellation and selection', 'cold preview and resume'], runtimeCacheCreated: false, helperAttached: false }, null, 2));
});


it.skipIf(!process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG)('isolates local macOS and two Linux SSH Worlds at the same path', async () => {
  await host?.close(); host = undefined;
  const selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG!, 'utf8'));
  const containers = JSON.parse(process.env.DSH_TEST_WORLD_CONTAINERS!);
  for (const world of selection.worlds) {
    execFileSync('docker', ['exec', '--user', 'root', containers[world.id], 'mkdir', '-p', project]);
    execFileSync('docker', ['exec', '--user', 'root', containers[world.id], 'chown', 'world:world', project]);
    execFileSync('docker', ['exec', containers[world.id], 'sh', '-c', 'printf %s "$1" > "$2/world.txt"', 'fixture', `SSH_${world.id}`, project]);
    world.workspaces = [{ path: project }];
  }
  const bindingFile = join(home, 'remote/bindings.json');
  await writeFile(join(home, 'remote/config.json'), JSON.stringify({ worlds: selection.worlds, bindingFile, bootstrap: {
    manifest: JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')), cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE,
  } }));
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: selection.worlds }));
  host = await launch(true);
  const registry = host.ctx.get('worldPortableWorkspaces');
  const worlds = host.ctx.get('executionWorlds');
  const workspaces = await Promise.all(['local', 'a', 'b'].map(id => registry.createInWorld(id, project)));
  expect(new Set(workspaces.map(row => row.id)).size).toBe(3);
  const created = await Promise.all(workspaces.map(row => host!.ctx.get('sessionController').create({ workspaceId: row.id })));
  const agents = created.map(row => host!.ctx.agents.get(row.sessionId)!);
  const markers = ['LOCAL_WORLD', 'SSH_a', 'SSH_b'];
  const reads = await Promise.all(agents.map(agent => tool(agent, 'read', { file_path: 'world.txt' })));
  reads.forEach((result, index) => { expect(result.isError).toBe(false); expect(JSON.stringify(result)).toContain(markers[index]); });
  expect(agents.map(agent => agent.session.header.agentPreset)).toEqual(['standard', 'remote', 'remote']);
  await Promise.all(agents.map(async (agent, index) => {
    expect((await tool(agent, 'bash', { command: `printf EFFECT_${index} > mixed-effect.txt`, description: 'Verify World isolation' })).isError).toBe(false);
  }));
  expect(await readFile(join(project, 'mixed-effect.txt'), 'utf8')).toBe('EFFECT_0');
  for (let i = 1; i < 3; i++) {
    const owner = worlds.forAgent(agents[i]);
    expect(await owner.fs.readText(await owner.fs.resolve('mixed-effect.txt'))).toBe(`EFFECT_${i}`);
    await expect(host.ctx.get('agentPresets').select(agents[i], 'standard')).rejects.toThrow('execution environment');
    const permissionEvents = agents[i].session.snapshotEvents();
    expect(() => host!.ctx.get('permissionPresets').set(agents[i].session, 'workspace-write')).toThrow('account permissions');
    expect(agents[i].session.snapshotEvents()).toEqual(permissionEvents);
    expect(() => agents[i].session.append('sandbox/mode', { mode: 'workspace-write' })).toThrow('SSH account');
  }
  await expect(host.ctx.get('sessionController').create({ sessionId: agents[0].id, workspaceId: workspaces[1].id })).rejects.toThrow();
  await expect(registry.create(project)).rejects.toThrow('explicit World');
  expect(() => worlds.forSession('unknown-session')).toThrow('no saved World');
  const reload = host.ctx.get('worldsReload');
  await writeFile(join(home, 'remote/worlds.json'), JSON.stringify({ worlds: [...selection.worlds, { id: 'local', name: 'My computer', target: { kind: 'local' }, workspaces: [{ name: 'Local project', path: project }] }] }));
  const preview = await reload.preview();
  expect(preview.errors).toEqual([]);
  expect(preview.skills).toEqual([]);
  expect((await reload.apply(preview.id)).applied).toBe(true);
  expect(registry.worlds().find(row => row.id === 'local').name).toBe('My computer');
  expect(registry.get(workspaces[0].id).title).toBe('Local project');
  const remoteClient = worlds.forAgent(agents[1]).remoteWorld.client;
  execFileSync('docker', ['stop', containers.a]);
  await expect.poll(() => remoteClient.state).not.toBe('ready');
  expect((await tool(agents[1], 'read', { file_path: 'world.txt' })).isError).toBe(true);
  await localOperations(agents[0], 'after-ssh-disconnect');
  expect((await tool(agents[2], 'read', { file_path: 'world.txt' })).isError).toBe(false);
  await writeFile(`${root}/artifacts/dsh/mixed-workspace-result.json`, JSON.stringify({ status: 'passed', topology: 'native macOS + two Linux SSH Worlds', samePath: true, localSurvivesSshDisconnect: true }, null, 2));
});
