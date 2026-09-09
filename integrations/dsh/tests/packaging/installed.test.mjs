import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const installation = resolve(process.env.DSH_TEST_INSTALL ?? 'target/official-install');
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));

test('native add, repeat add, version rejection and remove preserve official installation', async () => {
  await mkdir('target/package-check', { recursive: true });
  const home = await mkdtemp(resolve('target/package-check/native-'));
  const invoke = (...args) => execFileSync(process.execPath, ['--expose-internals', join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...args], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', stdio: 'pipe', timeout: 30000,
  });
  const plugin = (...args) => invoke('plugin', '--profile', 'web', ...args);
  const files = [...new Set(series.patches.flatMap(patch => patch.packages))].map(name => join(installation, 'node_modules', name, 'lib/index.js'));
  const digest = () => Promise.all(files.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
  const before = await digest();
  try {
    const artifact = JSON.parse(await readFile('target/packages/extension-build.json', 'utf8'));
    const archive = resolve('target/packages', artifact.filename);
    plugin('add', archive); plugin('add', archive);
    const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
    assert.equal(profile.dsh.profile.bundles.filter(name => name === '@dsh-remote/extension').length, 1);
    const composed = invoke('--profile', 'web', '--dump-config');
    for (const name of ['session-controller', 'workspace-controller', 'skill']) assert.ok(composed.includes(`compat/@deepseek-ai/dsh-${name === 'skill' ? name : `api-${name}`}/lib/index.js`));
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
