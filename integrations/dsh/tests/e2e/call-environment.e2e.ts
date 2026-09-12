import { afterAll, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { chromium, type Browser } from 'playwright';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';

class ImageAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string) { return { ...await super.resolveModel(provider, model), inputModalities: ['text', 'image'] as const }; }
}
let host: WebScaffold | undefined;
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); await host?.close(); });

it('routes explicit tool environments without rebinding the caller', async () => {
  const extension = process.env.DSH_TEST_EXTENSION!;
  host = await launchWebScaffold({ extraOverlayPath: join(extension, 'cordis.patch.yml'),
    extraInstallAnchors: [join(extension, 'package.json')], compareReplaySession: false,
    directoryPicking: true, persistentStateRoot: process.env.DSH_REMOTE_STATE!,
    harnessHome: join(process.env.DSH_REMOTE_STATE!, 'home'), toolsMode: 'native' });
  browser = await chromium.launch({ headless: true });
  let page = await newEnglishPage(browser);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.authenticatedUrl);
  const existing = new Set(host.ctx.agents.list().map(agent => agent.id));
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
  const selected = () => host!.ctx.agents.list().find(agent => !existing.has(agent.id) && agent.session.header.origin !== 'subagent');
  await expect.poll(selected, { timeout: 30000 }).toBeDefined();
  let agent = selected()!;
  const execute = (line: string) => host!.ctx.commands.execute(agent, line, [], AbortSignal.timeout(10000));

  const binding = host.ctx.get('executionWorlds').bindings.get(agent.id);
  const beforeWorkspaces = host.ctx.get('worldPortableWorkspaces').list().map(row => [row.id, row.updatedAt]);
  const target = { world: 'b', cwd: '/workspace' };
  const invoke = async (name: string, args: object, failed = false) => {
    if (name === 'bash') args = { description: 'Run the fixture command', ...args };
    const provider = 'environment-' + randomUUID();
    const callId = randomUUID();
    let captured: any;
    const stopResult = host!.ctx.on('tools/result', (exec, result) => { if (exec.agent?.id === agent.id && exec.name === name) captured = result; }, { global: true });
    host!.ctx.llm.registerAdapter([provider], new ImageAdapter([toolCallResponse(callId, name, args), textResponse('DONE')]));
    await host!.ctx.get('sessionController').selectModel({ sessionId: agent.id, provider, model: 'fixture' });
    await host!.ctx.get('sessionController').prompt({ sessionId: agent.id, requestId: randomUUID() as any, mode: 'queue', content: [{ type: 'text', text: 'Perform this fixture operation.' }] }, AbortSignal.timeout(30000));
    await agent.whenIdle();
    stopResult();
    const recorded = agent.session.snapshotEvents().findLast(event => event.type === 'tool/call');
    expect(recorded?.data.arguments).toBe(JSON.stringify(args));
    expect(captured, JSON.stringify(agent.session.snapshotEvents().slice(-3))).toBeDefined();
    expect(captured.isError, JSON.stringify(captured)).toBe(failed);
    return captured.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  };
  await execute('/permission danger-full-access');
  for (const name of ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'terminal_open', 'present']) {
    const schema = host.ctx.tools.schemas(agent).find(tool => tool.name === name);
    expect(schema?.parameters.properties.execution_environment, name).toBeDefined();
  }
  const filename = 'environment-' + randomUUID() + '.txt';
  const args = { execution_environment: target };
  await invoke('write', { ...args, file_path: filename, content: 'TARGET_B' });
  expect(await invoke('read', { ...args, file_path: filename })).toContain('TARGET_B');
  await page.getByText('1 tool call', { exact: true }).last().click();
  await page.locator('[data-tool="read"]').last().getByRole('button', { name: filename, exact: true }).click();
  await expect.poll(() => page.locator('[data-textpreview-plain]').textContent()).toContain('TARGET_B');
  await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh/call-tool-link.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark');
      await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh', `call-tool-${width}-${colorScheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  await invoke('edit', { ...args, file_path: filename, old_string: 'TARGET_B', new_string: 'UPDATED_B' });
  const mutation = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result') as any;
  expect(mutation.data.meta.producedFiles[0]).toMatch(/^world:\/\/b\//);
  expect(await invoke('grep', { ...args, pattern: 'UPDATED_B', path: filename })).toContain('UPDATED_B');
  expect(await invoke('glob', { ...args, pattern: filename })).toContain(filename);
  expect(await invoke('bash', { ...args, command: 'pwd; cat ' + filename })).toContain('UPDATED_B');
  expect(await invoke('bash', { ...args, workdir: 'nested', command: 'pwd' })).toContain('/workspace/nested');
  const parallel = await Promise.all(['a', 'b'].map(world => host!.ctx.tools.execute({ agent, name: 'bash',
    arguments: { execution_environment: { world, cwd: '/workspace' }, command: 'cat only-' + world + '.txt; printf ' + world, description: 'Identify target' },
    callId: ToolCallId(randomUUID()), signal: AbortSignal.timeout(10000) })));
  for (const [i, result] of parallel.entries()) {
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(JSON.stringify(result.content)).toContain(i === 0 ? 'markera' : 'markerb');
  }
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQYlWPQyPIkBjGMMHUAin9N2lOOmHUAAAAASUVORK5CYII=';
  await invoke('bash', { ...args, command: 'printf %s ' + png + ' | base64 -d > environment.png' });
  await invoke('read_image', { ...args, file_path: 'environment.png' });
  const source = host.ctx.get('executionWorlds').forAgent(agent);
  expect(await source.fs.stat(await source.fs.resolve(filename))).toBeUndefined();
  await invoke('present', { ...args, files: [{ path: filename }] });
  const presented = agent.session.snapshotEvents().findLast(event => event.type === 'deliverables/presented') as any;
  const address = presented.data.files[0].path;
  expect(address).toMatch(/^world:\/\//);
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(colorScheme === 'dark');
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark');
      await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh', `call-environment-${width}-${colorScheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.locator('[data-presented-file]').last().getByRole('button', { name: /^Open / }).first().click();
  await expect.poll(() => page.locator('[data-textpreview-plain]').textContent()).toContain('UPDATED_B');
  await expect.poll(() => page.locator('[data-textpreview-path]').getAttribute('title')).toBe('b/workspace/' + filename);
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark');
      await page.screenshot({ animations: 'disabled', path: join(process.env.DSH_REMOTE_ROOT!, '.build/dsh', `call-preview-${width}-${colorScheme}.png`) });
    }
  }
  const scope = { sessionId: agent.id, workspaceRoot: agent.session.header.cwd! };
  const bytes = await host.ctx.get('workspaceFiles').readAll(scope, address, AbortSignal.timeout(10000));
  expect(Buffer.from(bytes.data, 'base64').toString()).toBe('UPDATED_B');
  const related = await host.ctx.get('workspaceFiles').readRelated(scope, address, 'nested/file.txt', AbortSignal.timeout(10000));
  expect(Buffer.from(related.data, 'base64').toString()).toBe('nested');
  const stale = new URL(address); stale.searchParams.set('environment', '0'.repeat(64));
  await expect(host.ctx.get('workspaceFiles').readAll(scope, stale.href, AbortSignal.timeout(10000))).rejects.toThrow('no longer matches');
  // A new tool call defaults back to A, while background handles remain in B.
  await invoke('bash', { ...args, command: 'printf started > ' + filename + '.started; sleep 30', run_in_background: true });
  const jobs = host.ctx.get('jobs');
  const job = jobs.list(agent).find(job => job.status === 'running')!;
  expect(job).toBeDefined();
  await invoke('bash', { command: 'pwd' });
  expect(await invoke('job_output', { job_id: job.id })).toContain('[status: running]');
  await invoke('job_kill', { job_id: job.id });
  await expect.poll(() => jobs.get(job.id, agent).status).toBe('killed');
  await invoke('terminal_open', { ...args, type: 'shell', name: 'target-b' });
  const terminals = host.ctx.get('agentPresets').serviceFor(agent, 'terminals')!;
  const terminal = terminals.list(agent).find(terminal => terminal.name === 'target-b')!;
  expect(terminal).toBeDefined();
  await invoke('terminal_send', { sessionId: terminal.sessionId, text: 'cat ' + filename });
  expect(await invoke('terminal_read', { sessionId: terminal.sessionId })).toContain('UPDATED_B');
  await invoke('terminal_send', { sessionId: terminal.sessionId, text: 'printf TERMINAL_JOB_B; sleep 30', run_in_background: true });
  const terminalJob = jobs.list(agent).find(job => job.status === 'running')!;
  expect(terminalJob).toBeDefined();
  await invoke('bash', { command: 'pwd' });
  expect(await invoke('job_output', { job_id: terminalJob.id })).toContain('TERMINAL_JOB_B');
  await invoke('job_kill', { job_id: terminalJob.id });
  await expect.poll(() => jobs.get(terminalJob.id, agent).status).toBe('killed');
  await invoke('terminal_signal', { sessionId: terminal.sessionId, signal: 'SIGINT' });
  await invoke('terminal_close', { sessionId: terminal.sessionId });
  await invoke('bash', { execution_environment: { world: 'missing', cwd: '/workspace' }, command: 'true' }, true);
  await invoke('bash', { execution_environment: { world: 'b', cwd: '/missing-directory' }, command: 'true' }, true);
  await invoke('job_list', { ...args }, true);
  const local = join(process.env.DSH_REMOTE_STATE!, 'local-target');
  await mkdir(local, { recursive: true });
  await invoke('write', { execution_environment: { world: 'local', cwd: local }, file_path: filename, content: 'LOCAL_TARGET' });
  expect(await readFile(join(local, filename), 'utf8')).toBe('LOCAL_TARGET');
  await execute('/permission workspace-write');
  let decision = 'rejected';
  const reasons: string[] = [];
  const stop = host.ctx.on('approval/request', (request, next) => {
    if (request.agent.id !== agent.id) return next();
    reasons.push(request.reason);
    expect(request.reason).toContain('「b」');
    return decision;
  }, { prepend: true, global: true });
  await invoke('bash', { ...args, command: 'printf forbidden > ' + filename }, true);
  decision = 'allowed-once';
  await invoke('bash', { ...args, command: 'cat ' + filename });
  await invoke('terminal_open', { ...args, type: 'shell', name: 'approved-b' });
  const approved = terminals.list(agent).find(terminal => terminal.name === 'approved-b')!;
  await invoke('terminal_send', { sessionId: approved.sessionId, text: 'pwd' });
  expect(await invoke('terminal_read', { sessionId: approved.sessionId })).toContain('/workspace');
  await invoke('terminal_close', { sessionId: approved.sessionId });
  expect(reasons).toHaveLength(5);
  stop();
  expect(host.ctx.get('executionWorlds').bindings.get(agent.id)).toEqual(binding);
  expect(host.ctx.get('worldPortableWorkspaces').list().map(row => [row.id, row.updatedAt])).toEqual(beforeWorkspaces);
  const localWorkspace = await host.ctx.get('worldPortableWorkspaces').createInWorld('local', local);
  const prior = new Set(host.ctx.agents.list().map(agent => agent.id));
  page = await newEnglishPage(browser);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.authenticatedUrl);
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: 'local-target' }).first().click();
  await expect.poll(() => host!.ctx.agents.list().find(agent => !prior.has(agent.id) && agent.session.header.origin !== 'subagent')).toBeDefined();
  agent = host.ctx.agents.list().find(agent => !prior.has(agent.id) && agent.session.header.origin !== 'subagent')!;
  const localBinding = host.ctx.get('executionWorlds').bindings.get(agent.id);
  await execute('/permission danger-full-access');
  expect(await invoke('read', { ...args, file_path: filename })).toContain('UPDATED_B');
  await invoke('write', { ...args, file_path: 'from-local.txt', content: 'LOCAL_TO_B' });
  expect(await invoke('bash', { ...args, command: 'cat from-local.txt' })).toContain('LOCAL_TO_B');
  expect(await invoke('read', { file_path: filename })).toContain('LOCAL_TARGET');
  expect(host.ctx.get('executionWorlds').bindings.get(agent.id)).toEqual(localBinding);
  expect(localWorkspace.id).toBeDefined();
  expect(errors).toEqual([]);
}, 120000);
