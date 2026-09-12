import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseManifest, selectBundle } from '../../../../runtime/ssh/src/manifest.ts';
import { releaseBootstrap } from '../../packaging/extension/download.mjs';

test('automatic runtime acquisition pins the extension, shares downloads, reuses offline cache and rejects corruption', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-download-test-'));
  try {
    const source = join(state, 'source');
    await mkdir(join(source, 'artifacts'), { recursive: true });
    const bytes = Buffer.from('runtime fixture');
    const artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const expected = { version: '0.3.1', dshVersion: '0.1.5-alpha.1', revision: 'a'.repeat(40) };
    const filename = 'dsh-remote-extension-0.3.1.tgz';
    const release = { format: 1, sourceRevision: 'b'.repeat(40), sourceDirty: false, upstreamRevision: expected.revision,
      dshVersion: expected.dshVersion, extensionVersion: expected.version, extension: { filename, ...artifact },
      manifest: { format: 1, bundles: [{ target: { os: 'linux', arch: 'x86_64', abi: { kind: 'glibc', minimum: '2.36' } },
        helper: { version: '0.1.3', api: 2, artifact }, ripgrep: { version: '13.0.0', artifact } }] } };
    const extraArtifacts = [];
    for (const target of [{ os: 'linux', arch: 'aarch64', abi: { kind: 'musl-static' } }, { os: 'macos', arch: 'aarch64', abi: { kind: 'darwin' } }]) {
      const data = Buffer.from(`${target.os}/${target.arch} fixture`);
      const item = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
      extraArtifacts.push([item, data]);
      release.manifest.bundles.push({ ...release.manifest.bundles[0], target, helper: { ...release.manifest.bundles[0].helper, artifact: item } });
      await writeFile(join(source, 'artifacts', item.sha256), data);
    }
    await writeFile(join(source, 'release.json'), JSON.stringify(release));
    for (const file of [filename, `artifacts/${artifact.sha256}`, 'LICENSE', 'LICENSE-RIPGREP']) await writeFile(join(source, file), bytes);
    const pack = () => execFileSync('tar', ['-czf', join(state, 'runtime.tar.gz'), '-C', source, '.']);
    pack();
    let calls = 0;
    const fetchRelease = async url => {
      assert.equal(url, 'https://github.com/aur3l14no/dsh-remote/releases/download/v0.3.1/dsh-remote-runtime.tar.gz');
      calls++;
      return new Response(await readFile(join(state, 'runtime.tar.gz')));
    };
    const download = releaseBootstrap(join(state, 'home'), expected, parseManifest, fetchRelease);
    const [a, b] = await Promise.all([download(), download()]);
    assert.deepEqual(a, b); assert.equal(calls, 1);
    assert.equal(await readFile(join(a.cacheDir, artifact.sha256), 'utf8'), bytes.toString());
    assert.equal(a.manifest.bundles.length, 3);
    for (const [item, data] of extraArtifacts) assert.deepEqual(await readFile(join(a.cacheDir, item.sha256)), data);
    assert.equal(selectBundle(a.manifest, { os: 'linux', arch: 'aarch64' }).target.abi.kind, 'musl-static');
    assert.equal(selectBundle(a.manifest, { os: 'macos', arch: 'aarch64' }).target.abi.kind, 'darwin');
    const offline = releaseBootstrap(join(state, 'home'), expected, parseManifest, () => { throw new Error('Offline'); });
    assert.deepEqual(await offline(), a);
    await writeFile(join(source, 'artifacts', artifact.sha256), 'bad'); pack();
    const retry = releaseBootstrap(join(state, 'retry'), expected, parseManifest, fetchRelease);
    await assert.rejects(retry(), /mismatch/);
    await writeFile(join(source, 'artifacts', artifact.sha256), bytes); pack();
    await retry(); // An interrupted/invalid download never poisons the next connection.
    await writeFile(join(source, 'release.json'), JSON.stringify({ ...release, upstreamRevision: 'c'.repeat(40) })); pack();
    await assert.rejects(releaseBootstrap(join(state, 'wrong'), expected, parseManifest, fetchRelease)(), /does not match/);
  } finally { await rm(state, { recursive: true, force: true }); }
});
