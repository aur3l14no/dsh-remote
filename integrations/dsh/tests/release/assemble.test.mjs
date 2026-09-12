import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cacheArtifact } from '../../../../runtime/ssh/src/manifest.ts';

test('multi-platform release requires complete matching source identities and verified artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-platform-release-'));
  try {
    const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
    const filename = 'dsh-remote-extension-0.4.1.tgz', archive = Buffer.from('test extension');
    await writeFile(join(root, filename), archive);
    await writeFile(join(root, 'build.json'), JSON.stringify({ filename, extensionVersion: '0.4.1', sourceRevision: 'a'.repeat(40), sourceDirty: false,
      dshVersion: series.release.version, revision: series.revision, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` }));
    const targets = [{ os: 'linux', arch: 'x86_64', abi: { kind: 'musl-static' } }, { os: 'linux', arch: 'aarch64', abi: { kind: 'musl-static' } }, { os: 'macos', arch: 'aarch64', abi: { kind: 'darwin' } }];
    const paths = [];
    for (const target of targets) {
      const path = join(root, 'platforms', `${target.os}-${target.arch}`); paths.push(path);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'binary'), `${target.os}/${target.arch}`);
      const artifact = await cacheArtifact(join(path, 'binary'), join(path, 'artifacts'));
      await writeFile(join(path, 'manifest.json'), JSON.stringify({ format: 1, bundles: [{ target,
        helper: { version: '0.1.5', api: 2, artifact }, ripgrep: { version: '15.2.0', artifact } }] }));
      await writeFile(join(path, 'LICENSE-RIPGREP'), 'same upstream license');
      await writeFile(join(path, 'source.json'), JSON.stringify({ revision: 'a'.repeat(40), dirty: false }));
    }
    const output = join(root, 'release');
    const run = () => execFileSync(process.execPath, [resolve('integrations/dsh/scripts/assemble-runtime-release.mjs'), join(root, 'build.json'), join(root, 'platforms'), output], { stdio: 'pipe' });
    await writeFile(join(paths[0], 'source.json'), JSON.stringify({ revision: 'b'.repeat(40), dirty: false }));
    assert.throws(run, e => String(e.stderr).includes('source identities differ'));
    await assert.rejects(access(output));
    await writeFile(join(paths[0], 'source.json'), JSON.stringify({ revision: 'a'.repeat(40), dirty: false }));
    run();
    assert.equal(JSON.parse(await readFile(join(output, 'release.json'), 'utf8')).manifest.bundles.length, 3);
    await rm(output, { recursive: true });
    await rm(paths[2], { recursive: true });
    assert.throws(run, e => String(e.stderr).includes('Release requires'));
    await assert.rejects(access(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});
