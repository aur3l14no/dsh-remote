import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const installed = createRequire(resolve('.build/dsh/official-install/package.json'));
const { Context } = await import(pathToFileURL(installed.resolve('@deepseek-ai/cordis')));
const bundled = await build({ entryPoints: ['.build/dsh/extension-source/packages/client/ui-sidebar-right/src/client/tab-registry.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'official-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, ({ path }) => ({ path: pathToFileURL(installed.resolve(path)).href, external: true }));
  } }] });
const { SidebarRightTabRegistry } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('native Sidebar namespace claims keep Session and dot segments for the owning filesystem', () => {
  const registry = new SidebarRightTabRegistry(new Context());
  const seen = [];
  registry.register({ id: 'document', kind: 'text', priority: 'fallback', patterns: ['dsh-resource://file/**'],
    canOpen(address) { seen.push(address); return address.includes('/session/'); }, title: address => address });
  for (const path of ['../workspace/coding-0.txt', 'link/../file.txt', './file.txt', '/tmp/file.txt', 'file.txt']) {
    const address = `dsh-resource://file/session/world-a/${path}`;
    const claim = registry.claim(address);
    assert.equal(claim.contentId, address);
    assert.equal(seen.at(-1), address);
  }
  assert.equal(registry.candidates('dsh-resource://file/absolute/tmp/file.txt').length, 0);
  assert.equal(registry.candidates('dsh-resource://file-other/session/world-a/../file.txt').length, 0);
});
