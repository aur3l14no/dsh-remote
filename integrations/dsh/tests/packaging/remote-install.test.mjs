import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const execute = promisify(execFile);

test('official CLI installs a fixed-name remote tarball through a latest redirect', async () => {
  const build = JSON.parse(await readFile('dist/dsh/extension-build.json', 'utf8'));
  const archive = await readFile(resolve('dist/dsh', build.filename));
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, build.integrity);
  const latest = '/releases/latest/download/dsh-remote-extension.tgz';
  const versioned = `/releases/download/v${build.extensionVersion}/dsh-remote-extension.tgz`;
  const requested = new Set();
  const server = createServer((request, response) => {
    requested.add(request.url);
    if (request.url === latest) response.writeHead(302, { location: versioned }).end();
    else if (request.url === versioned) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length }).end(archive);
    } else response.writeHead(404).end();
  });
  await mkdir('.build/dsh/package-check', { recursive: true });
  const home = await mkdtemp(resolve('.build/dsh/package-check/remote-'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const installation = resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install');
    const invoke = (...args) => execute(process.execPath, [
      '--expose-internals', join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      'plugin', '--profile', 'web', ...args,
    ], { env: { ...process.env, DSH_HOME: home }, timeout: 60000 });
    const url = `http://127.0.0.1:${server.address().port}${latest}`;
    await invoke('add', url);
    assert.ok(requested.has(latest));
    assert.ok(requested.has(versioned));
    const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
    assert.equal(profile.dsh.profile.bundles.filter(name => name === '@dsh-remote/extension').length, 1);
    const installed = JSON.parse(await readFile(join(home, 'profiles/web/node_modules/@dsh-remote/extension/package.json'), 'utf8'));
    assert.equal(installed.version, build.extensionVersion);
    assert.ok(installed.dsh.bundle.patch);
    await invoke('remove', '@dsh-remote/extension');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
