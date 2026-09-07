import { readFile } from 'node:fs/promises';
import { deploySkills } from '../plugins/skills/src/deploy.ts';
const file = process.argv[2];
if (!file) throw new Error('Usage: node integrations/dsh/scripts/deploy-skills.mjs CONFIG.json');
const config = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(config.worlds)) throw new Error('Expected worlds: [{id, target, skills: [{name, source}]}]');
for (const world of config.worlds) {
  const installed = await deploySkills(world);
  console.log(JSON.stringify({ world: world.id, installed }));
}
