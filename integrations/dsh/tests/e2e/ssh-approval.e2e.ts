import { afterAll, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';

let host: WebScaffold | undefined;
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); await host?.close(); });

it('enforces SSH file authorization through native approval requests', async () => {
  const extension = process.env.DSH_TEST_EXTENSION!;
  host = await launchWebScaffold({ extraOverlayPath: join(extension, 'cordis.patch.yml'),
    extraInstallAnchors: [join(extension, 'package.json')], compareReplaySession: false,
    directoryPicking: true, persistentStateRoot: process.env.DSH_REMOTE_STATE!,
    harnessHome: join(process.env.DSH_REMOTE_STATE!, 'home'), toolsMode: 'native' });
  browser = await chromium.launch({ headless: true });
  const page = await newEnglishPage(browser);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.authenticatedUrl);
  const existing = new Set(host.ctx.agents.list().map(agent => agent.id));
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
  const selected = () => host!.ctx.agents.list().find(agent => !existing.has(agent.id) && agent.session.header.origin !== 'subagent');
  await expect.poll(selected, { timeout: 30000 }).toBeDefined();
  const agent = selected()!;
  const execute = (line: string) => host!.ctx.commands.execute(agent, line, [], AbortSignal.timeout(10000));
  await execute('/permission workspace-write');
  let answer: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once';
  let mutatePolicy = false;
  let asks = 0;
  const stop = host.ctx.on('approval/request', async (request: any, next: any) => {
    if (request.agent.id !== agent.id) return next();
    asks++;
    expect(request.reason).not.toContain('Execution World');
    expect(request.reason).not.toContain('helperBuild');
    if (mutatePolicy) {
      await execute('/permission danger-full-access');
      await execute('/permission workspace-write');
    }
    return answer;
  }, { prepend: true, global: true });
  const invoke = async (name: string, args: object) => {
    const provider = 'gate-' + randomUUID();
    host!.ctx.llm.registerAdapter([provider], new MockAdapter([toolCallResponse(randomUUID(), name, args), textResponse('DONE')]));
    await host!.ctx.get('sessionController').selectModel({ sessionId: agent.id, provider, model: 'fixture' });
    await host!.ctx.get('sessionController').prompt({ sessionId: agent.id, requestId: randomUUID() as any, mode: 'queue', content: [{ type: 'text', text: 'Perform this fixture operation.' }] }, AbortSignal.timeout(30000));
    await agent.whenIdle();
  };
  const owner = host.ctx.get('executionWorlds').forAgent(agent);
  const filename = 'gate-' + randomUUID() + '.txt';
  const file = await owner.fs.resolve(filename, { cwd: agent.session.header.cwd });
  await invoke('write', { file_path: filename, content: 'before' });
  expect(await owner.fs.readText(file)).toBe('before');
  expect(asks).toBe(0);
  answer = 'rejected';
  await invoke('edit', { file_path: filename, old_string: 'before', new_string: 'after' });
  expect(await owner.fs.readText(file)).toBe('after');
  expect(asks).toBe(0);
  const outsideName = '/tmp/' + filename;
  const outside = await owner.fs.resolve(outsideName);
  await invoke('write', { file_path: outsideName, content: 'outside' });
  await expect(owner.fs.readText(outside)).rejects.toThrow();
  answer = 'allowed-once';
  await invoke('write', { file_path: outsideName, content: 'outside' });
  expect(await owner.fs.readText(outside)).toBe('outside');
  answer = 'rejected';
  await invoke('edit', { file_path: outsideName, old_string: 'outside', new_string: 'changed' });
  expect(await owner.fs.readText(outside)).toBe('outside');
  await invoke('read', { file_path: filename });
  expect(asks).toBe(3);
  for (const denied of ['cancelled', 'unavailable'] as const) {
    answer = denied;
    await invoke('bash', { command: 'printf blocked > ' + filename, description: 'Overwrite test marker' });
    expect(await owner.fs.readText(file)).toBe('after');
  }
  answer = 'allowed-once'; mutatePolicy = true;
  await invoke('bash', { command: 'printf stale > ' + filename, description: 'Overwrite test marker' });
  expect(await owner.fs.readText(file)).toBe('after');
  mutatePolicy = false;
  expect(asks).toBe(6);
  await execute('/permission danger-full-access');
  await invoke('bash', { command: 'printf full > ' + filename, description: 'Overwrite test marker' });
  expect(await owner.fs.readText(file)).toBe('full');
  expect(asks).toBe(6);
  await execute('/permission read-only');
  answer = 'rejected';
  await invoke('write', { file_path: filename, content: 'read-only' });
  expect(await owner.fs.readText(file)).toBe('full');
  expect(asks).toBe(7);
  await execute('/permission workspace-write');
  host.ctx.approval.setPolicy(agent, 'never');
  await invoke('read', { file_path: filename });
  await invoke('write', { file_path: filename, content: 'permitted' });
  expect(await owner.fs.readText(file)).toBe('permitted');
  await invoke('bash', { command: 'printf blocked > ' + filename, description: 'Overwrite test marker' });
  expect(await owner.fs.readText(file)).toBe('permitted');
  expect(asks).toBe(7);
  stop();
  await execute('/permission workspace-write');
  const pending = invoke('bash', { command: 'printf human > ' + filename, description: 'Update the fixture marker' });
  const approval = page.getByRole('group', { name: 'Approval details' });
  await approval.waitFor();
  expect(await approval.innerText()).toContain('是否允许');
  expect(await approval.innerText()).not.toContain('Execution World');
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await approval.boundingBox())?.width ?? 0).toBeGreaterThan(width === 390 ? 200 : 500);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh', 'rooted-approval-' + width + '-' + colorScheme + '.png') });
    }
  }
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await pending;
  expect(await owner.fs.readText(file)).toBe('permitted');
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  expect(errors).toEqual([]);
}, 90000);
