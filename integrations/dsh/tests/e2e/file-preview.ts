import { writeFile, rm } from 'node:fs/promises';
import { expect } from 'vitest';
import type { Page } from 'playwright';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { WebScaffold } from './scaffold.ts';

export async function checkFilePreview(scaffold: WebScaffold, page: Page, first: Agent, second: Agent) {
  const ctx = scaffold.ctx;
  const a = ctx.get('executionWorlds').forAgent(first).fs;
  const b = ctx.get('executionWorlds').forAgent(second).fs;
  const files = ctx.get('workspaceFiles');
  const signal = AbortSignal.timeout(15000);
  const path = '/workspace/preview.svg';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"><text>A</text></svg>';
  await a.writeText(await a.resolve(path), svg);
  await b.writeText(await b.resolve(path), 'WORLD_B_PREVIEW');
  expect((await files.read(first, path, {}, signal)).text).toBe(svg);
  expect((await files.read(second, path, {}, signal)).text).toBe('WORLD_B_PREVIEW');
  expect(Buffer.from((await files.readBytes(first, path, { offset: 2, length: 7 }, signal)).data, 'base64').toString()).toBe(svg.slice(2, 9));
  expect((await files.list(first, '.', signal)).entries.some(entry => entry.name === 'preview.svg')).toBe(true);
  // A host file and two remote files deliberately share one absolute path.
  const shared = `/tmp/dsh-preview-${crypto.randomUUID()}.txt`;
  await writeFile(shared, 'HOST_MUST_NOT_BE_READ');
  try {
    await a.writeText(await a.resolve(shared), 'REMOTE_A');
    await b.writeText(await b.resolve(shared), 'REMOTE_B');
    const url = new URL('/api/file', page.url());
    url.searchParams.set('path', shared);
    expect((await page.request.get(url.href)).status()).toBe(400);
    url.searchParams.set('sessionId', first.session.header.id);
    const firstResponse = await page.request.get(url.href);
    expect(firstResponse.status()).toBe(200);
    expect(await firstResponse.text()).toBe('REMOTE_A');
    expect((await page.request.head(url.href)).headers()['content-length']).toBe('8');
    url.searchParams.set('sessionId', second.session.header.id);
    expect(await (await page.request.get(url.href)).text()).toBe('REMOTE_B');
    url.searchParams.set('sessionId', 'missing-preview-session');
    expect((await page.request.get(url.href)).status()).not.toBe(200);
    await expect(files.read(first, shared, {}, signal)).rejects.toThrow('outside the workspace');
    const link = ctx.get('executionWorlds').forAgent(first).subprocess.spawn({ argv: ['ln', '-s', shared, '/workspace/outside-preview-link'], cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
    expect((await link.done).exitCode).toBe(0);
    await link.waitForExit();
    await expect(files.read(first, '/workspace/outside-preview-link', {}, signal)).rejects.toThrow(/symlink|not.*regular/);
  } finally { await rm(shared, { force: true }); }
  expect(a.contains(await a.resolve('/workspace'), await b.resolve(path))).toBe(false);
  const watch = files.changes(first, signal)[Symbol.asyncIterator]();
  try {
    expect((await watch.next()).value?.kind).toBe('ready');
    const fromB = await b.resolve(path), fromA = await a.resolve(path);
    const infoB = await b.stat(fromB), infoA = await a.stat(fromA);
    ctx.emit('fs/observed', fromB, { kind: 'present', version: infoB!.version }, undefined);
    ctx.emit('fs/observed', fromA, { kind: 'present', version: infoA!.version }, undefined);
    expect((await watch.next()).value).toEqual({ kind: 'change', change: { absolutePath: path, version: infoA!.version } });
  } finally { await watch.return?.(); }
}
