import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cacheArtifact, parseManifest } from '../../../../runtime/ssh/src/manifest.ts';
import { readRelease } from '../../packaging/extension/release.mjs';

test('release packages only declared artifacts and rejects corruption without replacing output', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-release-test-'));
  try {
    const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
    const archive = Buffer.from('fixture extension tarball; never executed');
    const filename = 'dsh-remote-extension-0.3.0.tgz';
    await writeFile(join(state, filename), archive);
    await writeFile(join(state, 'build.json'), JSON.stringify({ filename, extensionVersion: '0.3.0', sourceRevision: 'a'.repeat(40), sourceDirty: false,
      dshVersion: series.release.version, revision: series.revision, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` }));
    await writeFile(join(state, 'binary'), 'fixture target binary; never executed');
    await writeFile(join(state, 'license'), 'fixture license');
    const artifact = await cacheArtifact(join(state, 'binary'), join(state, 'cache'));
    await writeFile(join(state, 'cache/private-token'), 'must never be packaged');
    await writeFile(join(state, 'manifest.json'), JSON.stringify({ format: 1, bundles: [{ target: { os: 'linux', arch: 'x86_64', abi: { kind: 'glibc', minimum: '2.36' } },
      helper: { version: '0.1.3', api: 1, artifact }, ripgrep: { version: '13.0.0', artifact } }] }));
    const output = join(state, 'release');
    const pack = () => execFileSync(process.execPath, [resolve('integrations/dsh/scripts/pack-release.mjs'), join(state, 'build.json'), join(state, 'manifest.json'),
      join(state, 'cache'), join(state, 'license'), output], { stdio: 'pipe' });
    pack();
    const verified = await readRelease(output, parseManifest);
    assert.equal(verified.manifest.bundles.length, 1);
    await assert.rejects(access(join(output, 'artifacts/private-token')));
    const metadata = await readFile(join(output, 'release.json'), 'utf8');
    assert.throws(pack); // Existing releases are never overwritten.
    assert.equal(await readFile(join(output, 'release.json'), 'utf8'), metadata);
    await writeFile(join(output, filename), Buffer.alloc(archive.length));
    await assert.rejects(readRelease(output, parseManifest), /checksum/);
    await writeFile(join(output, filename), archive);
    const binary = join(output, 'artifacts', artifact.sha256);
    await rm(binary);
    await symlink(join(state, 'binary'), binary);
    await assert.rejects(readRelease(output, parseManifest));
    await writeFile(join(output, 'release.json'), JSON.stringify({ ...JSON.parse(metadata), extension: { ...verified.release.extension, filename: '../escape.tgz' } }));
    await assert.rejects(readRelease(output, parseManifest), /metadata/);
    await rm(output, { recursive: true });
    await writeFile(join(state, filename), 'corrupted');
    assert.throws(pack, error => String(error.stderr).includes('integrity mismatch'));
    await assert.rejects(access(output));
    await writeFile(join(state, filename), archive);
    await rm(join(state, 'cache', artifact.sha256));
    assert.throws(pack);
    await assert.rejects(access(output)); // Failed assembly is retryable.
  } finally { await rm(state, { recursive: true, force: true }); }
});
