import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorldsReload } from '../../packages/workspace/portable-workspace/src/reload.ts';
import { SkillSynchronizer } from '../../packages/skill/remote-skills/src/sync.ts';
import { inspectSkill } from '../../packages/skill/remote-skills/src/state.ts';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
const config = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG, 'utf8'));
const state = await mkdtemp(resolve('.build/dsh/e2e/reload-'));
const source = join(state, 'skill');
await mkdir(source);
await mkdir(join(source, 'empty'));
await writeFile(join(source, '空 格\nslash\\quote".txt'), 'special filename', { mode: 0o755 });
await writeFile(join(source, 'SKILL.md'), '---\nname: reload-proof\ndescription: Reload fixture\n---\nVersion one\n');
const worlds = config.worlds.map(world => ({ ...world, skills: [{ name: 'reload-proof', source }] }));
const file = join(state, 'worlds.json');
const write = value => writeFile(file, JSON.stringify({ worlds: value }));
let active = structuredClone(worlds);
const registry = {
  validateCatalog(value) {
    assert.ok(Array.isArray(value));
    for (const world of value) {
      const old = active.find(item => item.id === world.id);
      if (old && JSON.stringify(old.target) !== JSON.stringify(world.target)) throw new Error('target changed');
    }
  },
  replaceCatalog(value) { this.validateCatalog(value); active = structuredClone(value); },
};
const sync = new SkillSynchronizer(worlds);
const reload = new WorldsReload({ worldPortableWorkspaces: registry }, file, worlds, sync);
const controls = worlds.map(world => sshControl(world.target));
const link = name => `test -L "$HOME/.agents/skills/${name}"`;
try {
  await write(worlds);
  assert.equal((await reload.status()).changed, false);
  let plan = await reload.preview();
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.skills.map(item => item.action), ['add', 'add']);
  assert.deepEqual(plan.skills[0].files.counts, { add: 3, update: 0, remove: 0 });
  assert.ok(plan.skills[0].files.items.some(item => item.path === '空 格\nslash\\quote".txt'));
  for (const control of controls) await assert.rejects(control(['sh', '-c', link('reload-proof')]));
  await reload.cancel(plan.id);
  await assert.rejects(reload.apply(plan.id), /expired/);
  // Approval applies the exact prepared content even when the local source changes later.
  plan = await reload.preview();
  await writeFile(join(source, 'SKILL.md'), '---\nname: reload-proof\ndescription: Reload fixture\n---\nVersion two\n');
  assert.equal((await reload.apply(plan.id)).applied, true);
  for (const control of controls) assert.match(await control(['sh', '-c', 'cat "$HOME/.agents/skills/reload-proof/SKILL.md"']), /Version one/);
  await rm(join(source, '空 格\nslash\\quote".txt'));
  await writeFile(join(source, 'added.txt'), 'new file');
  plan = await reload.preview();
  assert.deepEqual(plan.skills.map(item => item.action), ['update', 'update']);
  assert.deepEqual(plan.skills[0].files.counts, { add: 1, update: 1, remove: 1 });
  assert.equal(plan.skills[0].files.items.find(item => item.path === 'SKILL.md').action, 'update');
  assert.equal(plan.skills[0].files.items.find(item => item.path === 'added.txt').action, 'add');
  const changed = worlds.map(world => ({ ...world, color: '#336699' }));
  await write(changed);
  await assert.rejects(reload.apply(plan.id), /config changed since preview/);
  for (const control of controls) assert.match(await control(['sh', '-c', 'cat "$HOME/.agents/skills/reload-proof/SKILL.md"']), /Version one/);
  plan = await reload.preview();
  assert.equal((await reload.apply(plan.id)).applied, true);
  assert.equal(active[0].color, '#336699');
  // Drift after preview must refuse every write, including changes on the other World.
  plan = await reload.preview();
  await controls[1](['sh', '-c', 'printf drift >> "$HOME/.agents/skills/reload-proof/SKILL.md"']);
  await assert.rejects(reload.apply(plan.id), /changed since preview/);
  plan = await reload.preview();
  assert.ok(plan.errors.some(error => /version has drifted/.test(error)));
  await controls[1](['sh', '-c', 'sed -i \'$s/drift$//\' "$HOME/.agents/skills/reload-proof/SKILL.md"']);
  // Removing a selected skill removes only the managed symlink, preserving immutable data.
  const before = await inspectSkill(worlds[0].target, 'reload-proof');
  await write(changed.map(world => ({ ...world, enabledSkills: [] })));
  plan = await reload.preview();
  assert.deepEqual(plan.skills.map(item => item.action), ['remove', 'remove']);
  assert.equal((await reload.apply(plan.id)).applied, true);
  for (const control of controls) {
    await assert.rejects(control(['sh', '-c', link('reload-proof')]));
    await control(['sh', '-c', 'test -f "$HOME/.local/share/dsh-remote/skills/reload-proof/$1/SKILL.md"', 'test-version', before.split(':')[0]]);
  }
  // A foreign destination blocks the dry run; no target is modified.
  await controls[0](['sh', '-c', 'mkdir "$HOME/.agents/skills/reload-proof"']);
  await write(changed);
  plan = await reload.preview();
  assert.equal(plan.errors.length, 1);
  await assert.rejects(reload.apply(plan.id), /Resolve preview errors/);
  await controls[0](['sh', '-c', 'rmdir "$HOME/.agents/skills/reload-proof"']);
  // Failure between preflight and writes: locking the second destination leaves a truthful partial result.
  plan = await reload.preview();
  await controls[1](['sh', '-c', 'mkdir "$HOME/.local/share/dsh-remote/skills/.deploy-lock"']);
  let result = await reload.apply(plan.id);
  assert.equal(result.applied, false);
  assert.deepEqual(result.results.map(item => item.ok), [true, false]);
  assert.equal(sync.blocked, true);
  await assert.rejects(sync.beforeConnect({ ...worlds[0].target, id: 'test', cwd: '/' }), /needs repair/);
  await controls[1](['sh', '-c', 'rmdir "$HOME/.local/share/dsh-remote/skills/.deploy-lock"']);
  plan = await reload.preview();
  result = await reload.apply(plan.id);
  assert.equal(result.applied, true);
  assert.equal(sync.blocked, false);
  assert.equal((await reload.status()).changed, false);
  await writeFile(file, '{');
  assert.equal((await reload.status()).changed, true);
  plan = await reload.preview();
  assert.equal(plan.errors.length, 1);
  assert.equal(active.length, 2);
  console.log('PASS reload preview/cancel, frozen sources, stale config/state, managed removal, conflicts, partial failure and retry over two SSH Worlds');
} finally { await reload.dispose(); await sync.dispose(); await rm(state, { recursive: true, force: true }); }
