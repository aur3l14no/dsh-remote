import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

test('release workflow promotes exact bytes and rejects corrupt or prerelease assets before creating a draft', async () => {
  const workflow = load(await readFile('.github/workflows/release.yml', 'utf8'));
  const script = workflow.jobs.draft.steps.find(step => step.name === 'Create a draft from tested bytes without rebuilding').run;
  const state = await mkdtemp(join(tmpdir(), 'dsh-release-workflow-'));
  try {
    for (const directory of ['release', 'artifact', 'bin']) await mkdir(join(state, directory));
    // Intercept publication; the real workflow shell still stages and checks the files.
    await writeFile(join(state, 'bin/gh'), '#!/bin/sh\nprintf "%s\\n" "$@" > gh-args\n', { mode: 0o700 });
    const bytes = Buffer.from('CI-accepted extension fixture');
    const filename = 'dsh-remote-extension-0.3.0.tgz';
    const metadata = { sourceRevision: 'a'.repeat(40), extensionVersion: '0.3.0',
      extension: { filename, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const manifest = join(state, 'release/release.json');
    await writeFile(manifest, JSON.stringify(metadata));
    await writeFile(join(state, 'release', filename), bytes);
    await writeFile(join(state, 'artifact/dsh-remote-linux-x86_64.tar.gz'), 'complete archive fixture');
    const run = () => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: state, env: { ...process.env, PATH: `${join(state, 'bin')}:${process.env.PATH}` }, stdio: 'pipe',
    });
    run();
    assert.deepEqual(await readFile(join(state, 'artifact/dsh-remote-extension.tgz')), bytes);
    const args = (await readFile(join(state, 'gh-args'), 'utf8')).trim().split('\n');
    assert.ok(args.includes('artifact/dsh-remote-extension.tgz'));
    assert.ok(!args.includes('artifact/SHA256SUMS'));
    await assert.rejects(access(join(state, 'artifact/SHA256SUMS')));
    assert.ok(args.includes('--draft'));
    assert.ok(!args.includes('--prerelease'));
    const publish = workflow.jobs.draft.steps.at(-1);
    assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
    assert.equal(publish.if, '${{ inputs.publish }}');
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', publish.run], {
      cwd: state, env: { ...process.env, PATH: `${join(state, 'bin')}:${process.env.PATH}` }, stdio: 'pipe',
    });
    assert.deepEqual((await readFile(join(state, 'gh-args'), 'utf8')).trim().split('\n'),
      ['release', 'edit', 'v0.3.0', '--draft=false', '--prerelease=false', '--latest']);
    await rm(join(state, 'gh-args'));
    await writeFile(join(state, 'release', filename), 'corrupt');
    assert.throws(run);
    await assert.rejects(access(join(state, 'gh-args')));
    await writeFile(join(state, 'release', filename), bytes);
    await writeFile(manifest, JSON.stringify({ ...metadata, extensionVersion: '0.3.0-beta.1' }));
    assert.throws(run);
    await assert.rejects(access(join(state, 'gh-args')));
  } finally { await rm(state, { recursive: true, force: true }); }
});
