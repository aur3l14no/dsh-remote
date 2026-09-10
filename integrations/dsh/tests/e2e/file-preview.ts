import { writeFile, rm } from 'node:fs/promises';
import { expect } from 'vitest';
import type { Page } from 'playwright';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WebScaffold } from './scaffold.ts';

export async function checkFilePreview(scaffold: WebScaffold, page: Page, first: Agent, second: Agent) {
  const ctx = scaffold.ctx;
  const a = ctx.get('executionWorlds').forAgent(first).fs;
  const b = ctx.get('executionWorlds').forAgent(second).fs;
  const files = ctx.get('workspaceFiles');
  const signal = AbortSignal.timeout(15000);
  const scopeA = { sessionId: first.session.header.id, workspaceRoot: '/workspace' };
  const scopeB = { sessionId: second.session.header.id, workspaceRoot: '/workspace' };
  const decode = (value: { data: string }) => Buffer.from(value.data, 'base64');
  const path = '/workspace/preview.svg';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"><text>A</text></svg>';
  await a.writeText(await a.resolve(path), svg);
  await b.writeText(await b.resolve(path), 'WORLD_B_PREVIEW');
  await a.writeText(await a.resolve('/tmp/dsh-preview.html'), '<!doctype html><link rel="stylesheet" href="dsh-preview.css"><p id="proof">REMOTE_HTML_A</p>');
  await a.writeText(await a.resolve('/tmp/dsh-preview.css'), '#proof { color: rgb(12, 34, 56); }');
  await b.writeText(await b.resolve('/tmp/dsh-preview.html'), 'WRONG_WORLD_HTML');
  await a.writeText(await a.resolve('/tmp/dsh-preview.pdf'), previewPdf());
  expect((await files.read(scopeA, path, {}, signal)).text).toBe(svg);
  expect((await files.read(scopeB, path, {}, signal)).text).toBe('WORLD_B_PREVIEW');
  expect(decode(await files.readBytes(scopeA, path, { offset: 2, length: 7 }, signal)).toString()).toBe(svg.slice(2, 9));
  expect((await files.list(scopeA, '.', signal)).entries.some(entry => entry.name === 'preview.svg')).toBe(true);
  // A host file and two remote files deliberately share one absolute path outside the workspace.
  const shared = `/tmp/dsh-preview-${crypto.randomUUID()}.txt`;
  const binary = `${shared}.bin`;
  const binaryA = Buffer.from('A\0binary');
  const binaryB = Buffer.from('B\0binary');
  await writeFile(shared, 'HOST_MUST_NOT_BE_READ');
  await writeFile(binary, 'HOST_BINARY_MUST_NOT_BE_READ');
  try {
    await a.writeText(await a.resolve(shared), 'REMOTE_A');
    await b.writeText(await b.resolve(shared), 'REMOTE_B');
    await a.writeText(await a.resolve(binary), binaryA.toString());
    await b.writeText(await b.resolve(binary), binaryB.toString());
    for (const [scope, text, bytes] of [[scopeA, 'REMOTE_A', binaryA], [scopeB, 'REMOTE_B', binaryB]] as const) {
      expect((await files.read(scope, shared, {}, signal)).text).toBe(text);
      expect(decode(await files.readAll(scope, shared, signal)).toString()).toBe(text);
      expect(decode(await files.readBytes(scope, binary, { offset: 1, length: 3 }, signal))).toEqual(bytes.subarray(1, 4));
      expect(decode(await files.readAll(scope, binary, signal))).toEqual(bytes);
      expect(decode(await files.readRelated(scope, path, `..${binary}`, signal))).toEqual(bytes);
      expect(decode(await files.readRelated(scope, shared, binary.slice('/tmp/'.length), signal))).toEqual(bytes);
      await expect(files.read(scope, binary, {}, signal)).rejects.toThrow(/NUL|not.*text/);
      await expect(files.list(scope, '/tmp', signal)).rejects.toThrow('outside the workspace');
    }
    // The binding, not a caller-supplied root, determines relative-path resolution.
    expect((await files.read({ ...scopeA, workspaceRoot: '/tmp' }, 'preview.svg', {}, signal)).text).toBe(svg);
    const missing = { ...scopeA, sessionId: SessionId('missing-preview-session') };
    await expect(files.readAll(missing, shared, signal)).rejects.toThrow();
    await expect(files.readRelated(scopeA, path, 'https://example.com/file', signal)).rejects.toThrow('relative filesystem path');
    const cancelled = AbortSignal.abort(new Error('Preview cancelled'));
    await expect(files.readAll(scopeA, shared, cancelled)).rejects.toThrow('Preview cancelled');

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
    url.searchParams.set('sessionId', missing.sessionId);
    expect((await page.request.get(url.href)).status()).not.toBe(200);
    const linkPath = `/workspace/preview-link-${crypto.randomUUID()}`;
    const link = ctx.get('executionWorlds').forAgent(first).subprocess.spawn({ argv: ['ln', '-s', shared, linkPath], cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
    expect((await link.done).exitCode).toBe(0);
    await link.waitForExit();
    await expect(files.read(scopeA, linkPath, {}, signal)).rejects.toThrow(/symlink|not.*regular/);
    await expect(files.readAll(scopeA, linkPath, signal)).rejects.toThrow(/symlink|not.*regular/);
    await expect(files.readRelated(scopeA, path, linkPath.slice('/workspace/'.length), signal)).rejects.toThrow(/symlink|not.*regular/);

    const fromB = await b.resolve(path), fromA = await a.resolve(path), outside = await a.resolve(shared);
    expect(a.contains(await a.resolve('/workspace'), fromB)).toBe(false);
    // Resolve/stat before subscribing so only the deliberately emitted observations are queued.
    const infoB = await b.stat(fromB), infoA = await a.stat(fromA), infoOutside = await a.stat(outside);
    const controller = new AbortController();
    const watch = files.changes(scopeA, AbortSignal.any([signal, controller.signal]))[Symbol.asyncIterator]();
    try {
      expect((await watch.next()).value?.kind).toBe('ready');
      ctx.emit('fs/observed', fromB, { kind: 'present', version: infoB!.version }, undefined);
      ctx.emit('fs/observed', outside, { kind: 'present', version: infoOutside!.version }, undefined);
      ctx.emit('fs/observed', fromA, { kind: 'present', version: infoA!.version }, undefined);
      expect((await watch.next()).value).toEqual({ kind: 'change', change: { absolutePath: path, version: infoA!.version } });
      const pending = watch.next();
      controller.abort();
      expect((await pending).done).toBe(true);
    } finally {
      controller.abort();
      await watch.return?.();
    }
  } finally {
    await rm(shared, { force: true });
    await rm(binary, { force: true });
  }
}

// ASCII-only PDF makes the real remote byte/readAll and browser PDF worker path deterministic.
function previewPdf(): string {
  const stream = '1 0 0 rg 0 0 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}`;
  return text + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
