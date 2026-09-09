import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploySkills } from '../../packages/skill/remote-skills/src/deploy.ts';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
const config = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
const directory = await mkdtemp(resolve('target/e2e/skills-'));
try {
  const source = resolve('integrations/dsh/tests/e2e/skills/remote-proof');
  for (const world of config.worlds) {
    const spec = { target: world.target, skills: [{ name: 'remote-proof', source }] };
    await assert.rejects(deploySkills({ target: world.target, skills: [{ name: 'missing-runtime', source, requires: ['dsh-missing-runtime-fixture'] }] }), /prerequisite unavailable/);
    const first = await deploySkills(spec);
    assert.deepEqual(await deploySkills(spec), first);
    const control = sshControl(world.target);
    const script = `${first[0].path}/scripts/proof.sh`;
    const mode = (await control(['stat', '-c', '%a', script])).trim();
    await control(['chmod', mode === '600' ? '644' : '600', script]);
    await assert.rejects(deploySkills(spec));
    await control(['chmod', mode, script]);
    assert.deepEqual(await deploySkills(spec), first);
    assert.equal((await control(['sh', '-c', 'readlink "$HOME/.agents/skills/remote-proof"'])).trim(), first[0].path);
    await control(['sh', '-c', 'cd /workspace; sh "$HOME/.agents/skills/remote-proof/scripts/proof.sh"']);
    assert.equal((await control(['cat', '/workspace/skill-proof.txt'])).trim(), world.id);
    await control(['sh', '-c', 'mkdir -p "$HOME/.agents/skills/conflict"']);
    await assert.rejects(deploySkills({ target: world.target, skills: [{ name: 'conflict', source }] }));
    await cp(source, directory, { recursive: true });
    await writeFile(`${directory}/updated.txt`, 'updated');
    await mkdir(`${directory}/empty-output`, { recursive: true });
    const updated = await deploySkills({ target: world.target, skills: [{ name: 'remote-proof', source: directory }] });
    assert.notEqual(updated[0].revision, first[0].revision);
    await control(['sh', '-c', 'test -d "$HOME/.agents/skills/remote-proof/empty-output"']);
    assert.equal((await control(['sh', '-c', 'cat "$HOME/.agents/skills/remote-proof/updated.txt"'])).trim(), 'updated');
  }
  console.log('PASS two-World skill deployment, idempotence, update, conflict refusal and bundled execution');
} finally { await rm(directory, { recursive: true, force: true }); }
