import { isAbsolute } from 'node:path';
import { deploySkills, type SkillInstall } from './deploy.ts';
import { targetFingerprint, type WorkspaceDefinition, type WorldTarget } from '../../../world/execution-world/src/identity.ts';

interface SkillWorld { id: string; target: WorldTarget; skills?: SkillInstall[]; enabledSkills?: string[] }
export const destinationKey = (target: SkillWorld['target']) => targetFingerprint(target);

/** Host-owned sources and explicit catalog targets; no model-provided paths. */
export class SkillSynchronizer {
  private readonly destinations = new Map<string, SkillWorld>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lifecycle = new AbortController();

  selection?: (worldId: string) => readonly string[] | undefined;

  constructor(worlds: SkillWorld[]) {
    const ids = new Set<string>();
    for (const world of worlds) {
      if (ids.has(world.id)) throw new Error('Duplicate skill World');
      ids.add(world.id);
      if (world.target.kind === 'local') {
        if (world.skills !== undefined || world.enabledSkills !== undefined) throw new Error('Local Worlds do not support remote skill deployment');
        continue;
      }
      if (world.skills?.some(skill => !isAbsolute(skill.source))) throw new Error('Automatic skill sources require absolute local paths');
      const key = destinationKey(world.target);
      const previous = this.destinations.get(key);
      if (previous && (JSON.stringify(previous.skills ?? []) !== JSON.stringify(world.skills ?? []) || JSON.stringify(previous.enabledSkills) !== JSON.stringify(world.enabledSkills))) throw new Error('Worlds sharing a target must select the same skills');
      this.destinations.set(key, world);
    }
  }

  async beforeConnect(definition: WorkspaceDefinition): Promise<void> {
    if (definition.kind === 'local') return;
    if (this.reloading || this.blocked) throw new Error('World reload is applying or needs repair; finish Reload worlds before connecting');
    const world = this.destinations.get(destinationKey(definition));
    if (!world || world.target.kind !== 'ssh') return; // Retired Worlds restore their saved binding without catalog synchronization.
    this.lifecycle.signal.throwIfAborted();
    const target = world.target;
    const key = destinationKey(target);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      this.lifecycle.signal.throwIfAborted();
      const selected = this.selection?.(world.id);
      const skills = (world.skills ?? []).filter(skill => selected === undefined || selected.includes(skill.name));
      if (skills.length) await deploySkills({ target, skills }, this.lifecycle.signal);
    });
    this.queues.set(key, pending);
    try { await pending; }
    finally { if (this.queues.get(key) === pending) this.queues.delete(key); }
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.reloading) throw new Error('World reload is already applying');
    this.reloading = true;
    try { await Promise.allSettled([...this.queues.values()]); return await action(); }
    finally { this.reloading = false; }
  }
  private reloading = false;
  blocked = false;
  replace(worlds: SkillWorld[]) {
    const next = new SkillSynchronizer(worlds);
    this.destinations.clear();
    for (const [key, world] of next.destinations) this.destinations.set(key, world);
  }

  async dispose(): Promise<void> {
    this.lifecycle.abort(new Error('Skill synchronization disposed'));
    await Promise.allSettled([...this.queues.values()]);
  }
}
