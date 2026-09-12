import { afterAll, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { chromium, type Browser } from 'playwright';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';
let host: WebScaffold | undefined;
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); await host?.close(); });

it('keeps Team coordination on the host while teammates execute in their Worlds', async () => {
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
  const lead = selected()!;
  await expect.poll(() => host!.ctx.get('worldPortableWorkspaces').list().some(row => row.sessionIds.includes(lead.id)), { timeout: 30000 }).toBe(true);
  await host.ctx.commands.execute(lead, '/permission danger-full-access', [], AbortSignal.timeout(10000));
  const invoke = async (agent: typeof lead, name: string, args: object, failed = false) => {
    const result = await host!.ctx.tools.execute({ agent, name, arguments: args,
      callId: ToolCallId(randomUUID()), signal: AbortSignal.timeout(30000) });
    expect(result.isError, JSON.stringify(result)).toBe(failed);
    return result;
  };
  const names = host.ctx.tools.schemas(lead).map(tool => tool.name);
  for (const name of ['spawn_teammate', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']) {
    expect(names.filter(item => item === name), name).toHaveLength(1);
  }
  const registry = host.ctx.get('worldPortableWorkspaces');
  const workspaceB = await registry.createInWorld('b', '/workspace');
  const binding = host.ctx.get('executionWorlds').bindings.get(lead.id);
  const before = registry.list().map(row => [row.id, row.updatedAt]);
  const task = (await invoke(lead, 'team_task_create', { subject: 'Review output', description: 'Host task board', write_scopes: ['src'] })).value as any;
  const call = (name: string, args: object) => toolCallResponse(randomUUID(), name, args);
  const workerScript = [
    call('read', { file_path: '/workspace/only-b.txt' }),
    call('bash', { command: 'cat only-a.txt', description: 'Read A', execution_environment: { world: 'a', cwd: '/workspace' } }),
    call('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'claim' }),
    call('team_task_update', { task_id: task.id, expected_revision: task.revision + 1, action: 'complete' }),
    call('send_message', { target: 'lead', message: 'B_READY' }),
    textResponse('READY'),
    call('read', { file_path: '/workspace/only-b.txt' }), textResponse('RESUMED'),
  ];
  const adapter = new MockAdapter(Array.from({ length: 30 }, () => options =>
    options.sessionId === lead.id || options.purpose ? textResponse('READY') : workerScript.shift() ?? textResponse('DONE')));
  host.ctx.llm.registerAdapter(['teams-fixture'], adapter);
  await host.ctx.get('sessionController').selectModel({ sessionId: lead.id, provider: 'teams-fixture', model: 'fixture' });
  await host.ctx.get('sessionController').prompt({ sessionId: lead.id, requestId: randomUUID() as any, mode: 'queue', content: [{ type: 'text', text: 'Initialize the team fixture.' }] }, AbortSignal.timeout(30000));
  await lead.whenIdle();
  const results: { agent: string; name: string; result: any }[] = [];
  host.ctx.on('tools/result', (exec, result) => results.push({ agent: exec.agent!.id, name: exec.name, result }), { global: true });
  const spawn = await invoke(lead, 'spawn_teammate', { name: 'worker-b', description: 'Read World B', prompt: 'Perform your work.', execution_environment: workspaceB.id });
  const member = (spawn.value as any).member;
  await expect.poll(() => results.filter(row => row.agent === member.id).length, { timeout: 30000 }).toBe(5);
  await expect.poll(() => host!.ctx.agents.get(member.id), { timeout: 30000 }).toBeUndefined();
  await lead.whenIdle();
  for (const row of results.filter(row => row.agent === member.id)) expect(row.result.isError, JSON.stringify(row)).toBe(false);
  expect(JSON.stringify(results.find(row => row.agent === member.id && row.name === 'read')?.result)).toContain('marker');
  expect(JSON.stringify(results.find(row => row.agent === member.id && row.name === 'bash')?.result)).toContain('marker');
  expect(host.ctx.get('executionWorlds').bindings.get(member.id).worldId).toBe('b');
  await invoke(lead, 'team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'complete' }, true);
  expect(lead.session.snapshotEvents().some(event => event.type === 'team/task')).toBe(true);
  await invoke(lead, 'send_message', { target: 'worker-b', message: 'RESUME_B' });
  await expect.poll(() => results.filter(row => row.agent === member.id && row.name === 'read').length, { timeout: 30000 }).toBe(2);
  await expect.poll(() => host!.ctx.agents.get(member.id), { timeout: 30000 }).toBeUndefined();
  expect(host.ctx.get('executionWorlds').bindings.get(member.id).worldId).toBe('b');
  expect(host.ctx.get('executionWorlds').bindings.get(lead.id)).toEqual(binding);
  expect(registry.list().map(row => [row.id, row.updatedAt])).toEqual(before);
  await page.getByRole('button', { name: 'Agent Team', exact: true }).click();
  await page.getByText('worker-b', { exact: true }).first().waitFor({ state: 'visible' });
  await page.getByText('Review output', { exact: true }).waitFor({ state: 'visible' });
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark');
      await page.getByRole('button', { name: 'Refresh Team', exact: true }).click();
      await expect.poll(async () => {
        const box = await page.getByRole('dialog', { name: 'Agent Team', exact: true }).boundingBox();
        return box !== null && box.x >= 0 && box.x + box.width <= width;
      }).toBe(true);
      await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh', `team-${width}-${colorScheme}.png`) });
    }
  }
  const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true });
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByPlaceholder('Task description', { exact: true }).fill('Updated on the host from narrow UI');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByPlaceholder('Task description', { exact: true }).waitFor({ state: 'hidden' });
  await panel.getByText('Updated on the host from narrow UI', { exact: true }).waitFor({ state: 'visible' });
  expect(((await invoke(lead, 'team_task_get', { task_id: task.id })).value as any).description).toBe('Updated on the host from narrow UI');
  await page.getByTitle('Open teammate conversation', { exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(member.id);
  expect(errors).toEqual([]);
}, 120000);
