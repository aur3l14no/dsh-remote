import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const source = resolve(process.env.DSH_TEST_SOURCE ?? '.build/dsh/extension-source');
const installed = createRequire(resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install', 'package.json'));
const load = async name => import(pathToFileURL(installed.resolve(name)));
const { Context } = await load('@deepseek-ai/cordis');
const { default: Sessions, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: LocalFileSystem } = await load('@deepseek-ai/dsh-fs-local');
const { default: TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
const output = resolve('.build/dsh/local-preview-check');
await mkdir(output, { recursive: true });
await build({
  entryPoints: {
    workspace: join(source, 'packages/api/workspace-files/src/index.ts'),
    media: join(source, 'packages/api/session-controller/src/media-references.ts'),
  },
  outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'official-services', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, ({ path }) => path.startsWith('node:') ? undefined : { path: installed.resolve(path), external: true });
    builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ loader: 'js', contents: ts.transpileModule(await readFile(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText }));
  } }],
});
const { WorkspaceFiles } = await import(pathToFileURL(join(output, 'workspace.mjs')));
const { SessionMediaReferences } = await import(pathToFileURL(join(output, 'media.mjs')));

test('patched preview plugins retain local FS reads without a World environment', async () => {
  const directory = await mkdtemp(join(output, 'files-'));
  const ctx = new Context();
  const routes = new Map();
  try {
    await writeFile(join(directory, 'local.txt'), 'LOCAL_PREVIEW\n');
    // Sibling plugins are intentional: putting fs on the root would hide missing inject declarations.
    await ctx.plugin(LocalFileSystem, { cwd: directory });
    await ctx.plugin(Sessions);
    await ctx.plugin(TypertRegistry);
    await ctx.plugin({ apply(scope) {
      scope.provide('attachments', { imageLimits: { maxImageBytes: 1024 } });
      scope.provide('connection', { fetch: { register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      } } });
    } });
    await ctx.plugin(WorkspaceFiles, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 });
    await ctx.plugin(SessionMediaReferences);
    assert.equal(ctx.get('workspaceFileEnvironment'), undefined);
    assert.equal(ctx.get('sessionMediaEnvironment'), undefined);
    // Call through a consumer that owns preview capability, not the root's unrestricted Context.
    let files;
    await ctx.plugin({ inject: ['workspaceFiles'], apply(scope) { files = scope.workspaceFiles; } });
    const scope = { sessionId: SessionId('local-preview'), workspaceRoot: directory };
    const signal = AbortSignal.timeout(5000);
    assert.equal((await files.read(scope, 'local.txt', {}, signal)).text, 'LOCAL_PREVIEW');
    assert.equal(Buffer.from((await files.readAll(scope, 'local.txt', signal)).data, 'base64').toString(), 'LOCAL_PREVIEW\n');
    assert.equal((await files.list(scope, '.', signal)).entries[0].name, 'local.txt');
    const watch = files.changes(scope, signal)[Symbol.asyncIterator]();
    try { assert.equal((await watch.next()).value.kind, 'ready'); }
    finally { await watch.return(); }
    const endpoint = new URL('https://local.test/api/file');
    endpoint.searchParams.set('path', join(directory, 'local.txt'));
    const route = routes.get('/api/file');
    assert.ok(route);
    const response = await route.fetch(new Request(endpoint));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'LOCAL_PREVIEW\n');
    const head = await route.fetch(new Request(endpoint, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '14');
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
