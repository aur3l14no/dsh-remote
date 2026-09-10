import type { Context } from '@deepseek-ai/cordis';
import { isAbsolute } from 'node:path';
import { deploySkills, type SkillInstall } from './deploy.ts';
import { worldDefinition, type WorldDefinition } from '../../../world/ssh-world/src/bindings.ts';

interface SkillWorld { id: string; target: Omit<WorldDefinition, 'id' | 'cwd'>; skills?: SkillInstall[] }
const destinationKey = (target: SkillWorld['target']) => JSON.stringify(worldDefinition({ ...target, id: 'skills', cwd: '/' }));
declare module '@deepseek-ai/cordis' { interface Context { worldSkillSync: SkillSynchronizer } }

/** Host-owned sources and explicit catalog targets; no model-provided paths. */
export class SkillSynchronizer {
  private readonly destinations = new Map<string, SkillWorld>();
  private readonly worlds = new Map<string, SkillWorld>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lifecycle = new AbortController();

  selection?: (worldId: string) => readonly string[] | undefined;

  constructor(worlds: SkillWorld[]) {
    for (const world of worlds) {
      if (this.worlds.has(world.id)) throw new Error('Duplicate skill World');
      this.register(world);
    }
  }
  register(world: SkillWorld): void {
    const existing = this.worlds.get(world.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(world)) throw new Error('Skill World changed');
      return;
    }
    if (world.skills?.some(skill => !isAbsolute(skill.source))) throw new Error('Automatic skill sources require absolute local paths');
    const key = destinationKey(world.target);
    const previous = this.destinations.get(key);
    if (previous && JSON.stringify(previous.skills ?? []) !== JSON.stringify(world.skills ?? [])) throw new Error('Worlds sharing a target must select the same skills');
    this.destinations.set(key, world);
    this.worlds.set(world.id, world);
  }

  async beforeConnect(definition: WorldDefinition): Promise<void> {
    const world = this.destinations.get(destinationKey(definition));
    if (!world) throw new Error('Skill synchronization requires a configured World');
    await this.sync(world.id);
  }

  async sync(worldId: string): Promise<{ count: number }> {
    this.lifecycle.signal.throwIfAborted();
    const world = this.worlds.get(worldId);
    if (!world) throw new Error('Unknown skill World');
    const key = destinationKey(world.target);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      this.lifecycle.signal.throwIfAborted();
      const selected = this.selection?.(world.id);
      const skills = (world.skills ?? []).filter(skill => selected === undefined || selected.includes(skill.name));
      if (skills.length) await deploySkills({ target: world.target, skills }, this.lifecycle.signal);
      return { count: skills.length };
    });
    this.queues.set(key, pending);
    try { return await pending; }
    finally { if (this.queues.get(key) === pending) this.queues.delete(key); }
  }

  async dispose(): Promise<void> {
    this.lifecycle.abort(new Error('Skill synchronization disposed'));
    await Promise.allSettled([...this.queues.values()]);
  }
}
