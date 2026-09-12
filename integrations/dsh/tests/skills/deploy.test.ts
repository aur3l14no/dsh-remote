import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, chmod, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploySkills, prepareSkills } from '../../packages/skill/remote-skills/src/deploy.ts';
import { inspectSkill, removeSkill } from '../../packages/skill/remote-skills/src/state.ts';

test('native skill deployment preserves fingerprints, updates links and refuses mode drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-native-'));
  const priorPath = process.env.PATH;
  const priorHome = process.env.DSH_SKILL_TEST_HOME;
  const target = { host: 'native-skill-fixture' };
  try {
    const source = join(root, 'source'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const directory of [source, home, bin]) await mkdir(directory);
    // An explicit native control fixture exercises the target shell utilities; it is not SSH acceptance.
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\nexport HOME="$DSH_SKILL_TEST_HOME"\nexec /bin/sh -c "$1"\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${priorPath}`;
    process.env.DSH_SKILL_TEST_HOME = home;
    await writeFile(join(source, 'SKILL.md'), '---\nname: platform-proof\ndescription: Platform fixture\n---\nProof\n');
    await writeFile(join(source, 'quoted \' file.txt'), 'original\n', { mode: 0o640 });
    const spec = { target, skills: [{ name: 'platform-proof', source }] };
    const first = await deploySkills(spec);
    assert.deepEqual(await deploySkills(spec), first);
    const prepared = await prepareSkills(spec.skills);
    try {
      const state = await inspectSkill(target, 'platform-proof');
      assert.equal(state, `${prepared.selected[0]!.revision}:${prepared.selected[0]!.contentDigest}`);
    } finally { await prepared.dispose(); }
    await writeFile(join(source, 'new.txt'), 'update\n');
    const second = await deploySkills(spec);
    assert.notEqual(second[0]!.revision, first[0]!.revision);
    assert.equal(await readlink(join(home, '.agents/skills/platform-proof')), second[0]!.path);
    assert.equal(await readFile(join(second[0]!.path, 'new.txt'), 'utf8'), 'update\n');
    await access(first[0]!.path);
    await chmod(join(second[0]!.path, 'new.txt'), 0o600);
    await assert.rejects(deploySkills(spec));
    await chmod(join(second[0]!.path, 'new.txt'), 0o644);
    const state = await inspectSkill(target, 'platform-proof');
    await removeSkill(target, 'platform-proof', state);
    assert.equal(await inspectSkill(target, 'platform-proof'), 'absent');
    await access(second[0]!.path);
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.DSH_SKILL_TEST_HOME; else process.env.DSH_SKILL_TEST_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});
