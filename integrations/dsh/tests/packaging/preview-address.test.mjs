import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

test('preview resource addresses retain the Session at root and refuse an unknown workspace', async () => {
  const bundled = await build({ entryPoints: ['target/extension-source/packages/client/ui-chat/src/client/file-preview-address.ts'],
    bundle: true, write: false, platform: 'node', format: 'esm', nodePaths: [resolve('target/official-install/node_modules')] });
  const { previewAddress } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  assert.equal(previewAddress('world-a-session', '/', '/tmp/same.txt'), 'dsh-resource://file/session/world-a-session/tmp/same.txt');
  assert.equal(previewAddress('world-b-session', '/workspace', '/workspace/same.txt'), 'dsh-resource://file/session/world-b-session/same.txt');
  assert.throws(() => previewAddress('session', undefined, '/tmp/same.txt'), /requires/);
  assert.throws(() => previewAddress('session', '/workspace', '/outside/same.txt'), /outside/);
});
