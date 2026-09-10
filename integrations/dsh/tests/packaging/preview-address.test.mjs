import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

test('native preview addresses keep relative and root-external paths in their owning Session', async () => {
  const bundled = await build({ entryPoints: ['.build/dsh/extension-source/packages/util/workspace-path/src/index.ts'],
    bundle: true, write: false, platform: 'node', format: 'esm', nodePaths: [resolve('.build/dsh/official-install/node_modules')] });
  const { fileAddressFor, parseFileAddress } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  assert.equal(fileAddressFor('world-a-session', '/', '/tmp/same.txt'), 'dsh-resource://file/session/world-a-session//tmp/same.txt');
  assert.equal(fileAddressFor('world-b-session', '/workspace', '/workspace/same.txt'), 'dsh-resource://file/session/world-b-session/same.txt');
  for (const cwd of [undefined, '/', '/workspace']) {
    assert.deepEqual(parseFileAddress(fileAddressFor('world-a-session', cwd, '/tmp/same.txt')), {
      scope: 'session', sessionId: 'world-a-session', path: '/tmp/same.txt',
    });
  }
  assert.deepEqual(parseFileAddress(fileAddressFor('world-b-session', '/workspace', '../tmp/a #%.txt')), {
    scope: 'session', sessionId: 'world-b-session', path: '../tmp/a #%.txt',
  });
});
