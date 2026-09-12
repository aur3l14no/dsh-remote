import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cacheArtifact } from '../../../../runtime/ssh/src/manifest.ts';
const installation = resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install');
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));

test('native add, repeat add, version rejection and remove preserve official installation', async () => {
  await mkdir('.build/dsh/package-check', { recursive: true });
  const home = await mkdtemp(resolve('.build/dsh/package-check/native-'));
  const invoke = (...args) => execFileSync(process.execPath, ['--expose-internals', join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...args], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', stdio: 'pipe', timeout: 30000,
  });
  const plugin = (...args) => invoke('plugin', '--profile', 'web', ...args);
  const files = [...new Set(series.patches.flatMap(patch => patch.packages))].map(name => join(installation, 'node_modules', name, 'lib/index.js'));
  const digest = () => Promise.all(files.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
  const before = await digest();
  try {
    const artifact = JSON.parse(await readFile('dist/dsh/extension-build.json', 'utf8'));
    const archive = resolve('dist/dsh', artifact.filename);
    plugin('add', archive); plugin('add', archive);
    const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
    assert.equal(profile.dsh.profile.bundles.filter(name => name === '@dsh-remote/extension').length, 1);
    const composed = invoke('--profile', 'web', '--dump-config');
    for (const name of ['session-controller', 'workspace-controller', 'skill']) assert.ok(composed.includes(`compat/@deepseek-ai/dsh-${name === 'skill' ? name : `api-${name}`}/lib/index.js`));
    const fixture = join(home, 'release-fixture');
    await mkdir(fixture);
    await writeFile(join(fixture, 'binary'), 'fixture binary, initialization must not execute it');
    const binary = await cacheArtifact(join(fixture, 'binary'), join(fixture, 'cache'));
    await writeFile(join(fixture, 'license'), 'fixture license');
    await writeFile(join(fixture, 'manifest.json'), JSON.stringify({ format: 1, bundles: [{ target: { os: 'linux', arch: 'x86_64', abi: { kind: 'glibc', minimum: '2.36' } },
      helper: { version: '0.1.3', api: 2, artifact: binary }, ripgrep: { version: '13.0.0', artifact: binary } }] }));
    const release = join(fixture, 'release');
    execFileSync(process.execPath, ['integrations/dsh/scripts/pack-release.mjs', 'dist/dsh/extension-build.json', join(fixture, 'manifest.json'),
      join(fixture, 'cache'), join(fixture, 'license'), release], { stdio: 'pipe' });
    await writeFile(join(fixture, 'worlds.json'), JSON.stringify({ worlds: [{ id: 'test', target: { kind: 'ssh', host: 'never-connected' } }] }));
    const init = () => plugin('exec', 'dsh-remote-config', 'init-release', release, join(fixture, 'worlds.json'));
    const releaseFile = join(release, 'release.json');
    const releaseMetadata = JSON.parse(await readFile(releaseFile, 'utf8'));
    await writeFile(releaseFile, JSON.stringify({ ...releaseMetadata, dshVersion: '9.9.9' }));
    assert.throws(init, error => String(error.stderr).includes('does not match'));
    await assert.rejects(access(join(home, 'remote')));
    await writeFile(releaseFile, JSON.stringify(releaseMetadata));
    const releaseBinary = join(release, 'artifacts', binary.sha256);
    await rm(releaseBinary);
    await writeFile(releaseBinary, 'corrupt');
    assert.throws(init, error => String(error.stderr).includes('mismatch'));
    await assert.rejects(access(join(home, 'remote')));
    await rm(releaseBinary);
    await cacheArtifact(join(fixture, 'binary'), join(release, 'artifacts'), binary);
    init();
    const initialized = await readFile(join(home, 'remote/config.json'), 'utf8');
    assert.throws(init);
    assert.equal(await readFile(join(home, 'remote/config.json'), 'utf8'), initialized);
    await rm(release, { recursive: true });
    assert.equal(await readFile(join(JSON.parse(initialized).bootstrap.cacheDir, binary.sha256), 'utf8'), 'fixture binary, initialization must not execute it');
    const file = join(home, 'profiles/web/node_modules/@dsh-remote/extension/extension.json');
    const metadata = JSON.parse(await readFile(file, 'utf8'));
    metadata.dshVersion = 'unsupported-test-version';
    await writeFile(file + ".test", JSON.stringify(metadata));
    await rename(file + ".test", file);
    assert.throws(() => invoke('--profile', 'web', '--no-open'), error => String(error.stderr).includes('Unsupported DSH'));
    plugin('remove', '@dsh-remote/extension');
    const restored = invoke('--profile', 'web', '--dump-config');
    assert.ok(!restored.includes('@dsh-remote/extension'));
    assert.ok(restored.includes('@deepseek-ai/dsh-api-session-controller'));
    assert.deepEqual(await digest(), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});
