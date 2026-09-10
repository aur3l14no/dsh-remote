import { readFile, readdir } from 'node:fs/promises';
import { afterAll, expect, it, onTestFailed } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { launchWebScaffold, type WebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';

const root = process.env.DSH_REMOTE_ROOT!;
const state = process.env.DSH_REMOTE_STATE!;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQYlWPQyPIkBjGMMHUAin9N2lOOmHUAAAAASUVORK5CYII=', 'base64');
class ImageAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), inputModalities: ['text', 'image'] as const };
  }
}
let host: WebScaffold | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
afterAll(async () => { await browser?.close(); await host?.close(); });

it('uploads through Chromium and retains remote authority across fork and restart', async () => {
  const launch = () => launchWebScaffold({
    extraOverlayPath: `${process.env.DSH_TEST_EXTENSION}/cordis.patch.yml`, extraInstallAnchors: [`${process.env.DSH_TEST_EXTENSION}/package.json`],
    compareReplaySession: false, directoryPicking: false, persistentStateRoot: state, harnessHome: `${state}/home`,
    agentPresets: { default: 'remote', roots: [{ path: `${process.env.DSH_TEST_EXTENSION}/presets`, trust: 'system' }] }, toolsMode: 'native',
  });
  host = await launch();
  browser = await chromium.launch({ headless: true });
  page = await newEnglishPage(browser);
  onTestFailed(async () => {
    if (!page || page.isClosed()) return;
    console.error('PAGE', await page.locator('body').innerText());
    await page.screenshot({ path: `${root}/artifacts/dsh/attachments-failure.png`, fullPage: true });
  });
  await page.goto(host.authenticatedUrl);
  if (!(await page.getByLabel('World', { exact: true }).isVisible())) await page.getByLabel('Connect or open a workspace', { exact: true }).click();
  await page.getByLabel('World', { exact: true }).selectOption('a');
  await page.getByLabel('Remote directory', { exact: true }).fill('/workspace');
  await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
  await expect.poll(() => host!.ctx.agents.list().length, { timeout: 30000 }).toBe(1);
  const agent = host.ctx.agents.list()[0]!;
  const id = agent.session.header.id;
  let image: ImageAttachmentRef | undefined;
  let file: FileAttachmentRef | undefined;
  const results: unknown[] = [];
  host.ctx.on('session/event', (_session, event) => {
    if (event.type === 'user/message') {
      for (const block of event.data.content) {
        if (block.type === 'image') image = block.attachment;
        if (block.type === 'file') file = block.attachment;
      }
    }
    if (event.type === 'tool/result') results.push(event.data);
  });
  const store = () => host!.ctx.get('attachments').forSession(id);
  const adapter = new ImageAdapter([
    () => toolCallResponse('attachment-read', 'read', { file_path: store().fileExecutionPath(file!)! }),
    () => toolCallResponse('attachment-image', 'read_image', { file_path: store().imageExecutionPath(image!)! }),
    textResponse('REMOTE_ATTACHMENTS_DONE'),
  ]);
  host.ctx.llm.registerAdapter(['attachment-fixture'], adapter);
  await host.ctx.get('sessionController').selectModel({ sessionId: id, provider: 'attachment-fixture', model: 'fixture' });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'remote-note.txt', mimeType: 'text/plain', buffer: Buffer.from('REMOTE_ATTACHMENT_FILE_OK\n') },
    { name: 'uploaded.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.locator('[data-composer-input][contenteditable=true]').first().fill('Read both attachments.');
  const send = page.getByRole('button', { name: 'Send message' });
  await expect.poll(() => send.isEnabled(), { timeout: 15000 }).toBe(true);
  const settled = host.whenTurnSettled();
  await send.click();
  await settled;
  expect(image?.attachmentId).toMatch(/@world-[a-f0-9]{64}$/);
  expect(file?.attachmentId).toMatch(/@world-[a-f0-9]{64}$/);
  expect(JSON.stringify(results)).toContain('REMOTE_ATTACHMENT_FILE_OK');
  expect(JSON.stringify(results)).not.toContain('"isError":true');
  expect(results).toHaveLength(2);
  expect(JSON.stringify(adapter.requests)).toContain(store().fileExecutionPath(file!)!);
  expect(JSON.stringify(adapter.requests)).not.toContain(`${state}/home`);
  const preview = () => page!.getByRole('img', { name: 'uploaded.png', exact: true }).first();
  await expect.poll(() => preview().evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 15000 }).toBe(13);
  const remotePath = store().imageExecutionPath(image!)!;
  expect(remotePath).toMatch(/^\/home\/world\/.local\/share\/dsh-remote\/attachments\//);
  await expect(readFile(`${state}/home/attachments/v1/objects/${image!.attachmentId.slice(7, 9)}/${image!.attachmentId.slice(7, 71)}`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(`${state}/home/remote/attachment-staging`)).toEqual([]);
  await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click();
  await expect.poll(() => host!.ctx.agents.list().find(item => item.session.header.parentSession === id), { timeout: 15000 }).toBeDefined();
  const fork = host.ctx.agents.list().find(item => item.session.header.parentSession === id)!;
  const forkId = fork.session.header.id;
  await host.ctx.sessionPersistence.flush();
  await page.screenshot({ path: `${root}/artifacts/dsh/attachments-uploaded.png`, fullPage: true });
  await page.close();
  await host.close();
  host = await launch();
  expect(host.ctx.agents.get(id)).toBeUndefined();
  const api = host.ctx.get('sessionController');
  const original = await api.attachment({ sessionId: id, attachmentId: image!.attachmentId });
  const branched = await api.attachment({ sessionId: forkId, attachmentId: image!.attachmentId });
  expect(branched.data).toBe(original.data);
  expect(host.ctx.agents.get(id)).toBeUndefined();
  page = await newEnglishPage(browser);
  await page.goto(host.authenticatedUrl);
  await page.getByRole('button', { name: `Open session ${id}`, exact: true }).click();
  await expect.poll(() => preview().evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 15000 }).toBe(13);
  await page.screenshot({ path: `${root}/artifacts/dsh/attachments-restarted.png`, fullPage: true });
});
