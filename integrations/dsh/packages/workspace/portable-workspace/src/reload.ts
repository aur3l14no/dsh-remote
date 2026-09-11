/** Host-owned catalog maintenance. No model tools or workspace-path authority. */
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { CatalogWorld } from './registry.ts';
import type { ReloadPreview, ReloadResult, ReloadStatus, ReloadSkill } from './contracts.ts';
import { prepareSkills, deployPrepared, type PreparedSkills } from '../../../skill/remote-skills/src/deploy.ts';
import { inspectSkill, removeSkill, verifySkillVersion, inspectSkillChanges } from '../../../skill/remote-skills/src/state.ts';
import { SkillSynchronizer, destinationKey } from '../../../skill/remote-skills/src/sync.ts';
import { sshControl } from '../../../../../../runtime/ssh/src/control.ts';

declare module '@deepseek-ai/cordis' { interface Context { worldsReload: WorldsReload } }
type SshCatalogWorld = CatalogWorld & { target: Extract<CatalogWorld['target'], { kind: 'ssh' }> };
interface TargetPlan { world: SshCatalogWorld; prepared: PreparedSkills; skills: ReloadSkill[] }
interface Plan { preview: ReloadPreview; digest: string; worlds: CatalogWorld[]; targets: TargetPlan[]; expires: number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class WorldsReload {
  private plan?: Plan;
  private busy = false;
  private pending?: Promise<unknown>;
  private generation = 0;
  private progress = { completed: 0, total: 0, current: undefined as string | undefined };
  private baseline: string;
  private worlds: CatalogWorld[];
  private readonly lifecycle = new AbortController();
  private readonly expiry: ReturnType<typeof setInterval>;
  private readonly ctx: Context;
  private readonly file: string;
  private readonly sync: SkillSynchronizer;
  constructor(ctx: Context, file: string, initial: CatalogWorld[], sync: SkillSynchronizer) {
    this.ctx = ctx; this.file = file; this.sync = sync;
    this.worlds = structuredClone(initial);
    this.baseline = digest(JSON.stringify(initial));
    this.expiry = setInterval(() => { if (!this.busy && this.plan && Date.now() > this.plan.expires) void this.cancel(this.plan.preview.id).catch(() => {}); }, 30000);
    this.expiry.unref();
  }
  private async read() {
    const text = await readFile(this.file, 'utf8');
    if (text.length > 1024 * 1024) throw new Error('World catalog exceeds 1 MiB');
    const worlds = JSON.parse(text).worlds as CatalogWorld[];
    if (!Array.isArray(worlds)) throw new Error('worlds.json requires a worlds array');
    return { worlds, digest: digest(JSON.stringify(worlds)) };
  }
  async status(): Promise<ReloadStatus> {
    try { return { changed: this.sync.blocked || (await this.read()).digest !== this.baseline, applying: this.busy, generation: this.generation, ...this.progress, error: this.sync.blocked ? 'A previous reload needs repair; preview again to finish applying.' : undefined }; }
    catch (error) { return { changed: true, applying: this.busy, generation: this.generation, ...this.progress, error: message(error) }; }
  }
  async cancel(id: string) {
    if (this.busy || this.plan?.preview.id !== id) return;
    const plan = this.plan; this.plan = undefined;
    await Promise.all(plan.targets.map(target => target.prepared.dispose()));
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    this.lifecycle.signal.throwIfAborted();
    if (this.pending) throw new Error('World reload is busy');
    const pending = action();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }
  preview(): Promise<ReloadPreview> { return this.run(() => this.previewPlan()); }
  apply(id: string): Promise<ReloadResult> { return this.run(() => this.applyPlan(id)); }
  private async previewPlan(): Promise<ReloadPreview> {
    if (this.busy) throw new Error('World reload is busy');
    this.busy = true;
    if (this.plan) {
      const previous = this.plan; this.plan = undefined;
      await Promise.all(previous.targets.map(target => target.prepared.dispose()));
    }
    const view: ReloadPreview = { id: randomUUID(), changes: [], skills: [], errors: [] };
    const targets: TargetPlan[] = [];
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(120000)]);
    try {
      const next = await this.read();
      await this.ctx.worldPortableWorkspaces.validateCatalog(next.worlds);
      new SkillSynchronizer(next.worlds); // Same target/source compatibility gate as startup.
      const previous = new Map(this.worlds.map(world => [world.id, world]));
      for (const world of next.worlds) {
        const old = previous.get(world.id);
        if (!old) view.changes.push({ world: world.name, kind: 'add', detail: `Add World\n${JSON.stringify(world, null, 2)}` });
        else for (const key of ['name', 'color', 'workspaces', 'skills', 'enabledSkills'] as const) {
          if (JSON.stringify(old[key]) !== JSON.stringify(world[key])) view.changes.push({ world: world.name, kind: key, detail: `${JSON.stringify(old[key]) ?? '(default)'} → ${JSON.stringify(world[key]) ?? '(default)'}` });
        }
        previous.delete(world.id);
      }
      for (const old of previous.values()) view.changes.push({ world: old.name, kind: 'remove', detail: 'Remove new-session entry; existing Sessions retain their saved binding' });
      const byTarget = new Map<string, { old?: CatalogWorld; next?: CatalogWorld }>();
      for (const world of this.worlds) byTarget.set(destinationKey(world.target), { old: world });
      for (const world of next.worlds) { const key = destinationKey(world.target); byTarget.set(key, { ...byTarget.get(key), next: world }); }
      for (const { old, next: world } of byTarget.values()) {
        const candidate = world ?? old!;
        if (candidate.target.kind === 'local') continue;
        const owner: SshCatalogWorld = { ...candidate, target: candidate.target };
        try {
          const selected = world?.enabledSkills;
          const desired = (world?.skills ?? []).filter(skill => selected === undefined || selected.includes(skill.name));
          const prepared = await prepareSkills(desired, signal);
          const target: TargetPlan = { world: owner, prepared, skills: [] };
          targets.push(target);
          for (const command of new Set(prepared.selected.flatMap(skill => skill.requires))) {
            await sshControl(owner.target)(['sh', '-c', 'command -v "$1" >/dev/null', 'dsh-skill-preview', command], { signal });
          }
          for (const name of new Set([...(old?.skills ?? []).map(skill => skill.name), ...(world?.skills ?? []).map(skill => skill.name)])) {
            const before = await inspectSkill(owner.target, name, signal);
            const install = prepared.selected.find(skill => skill.name === name);
            if (install) await verifySkillVersion(owner.target, name, install.revision, install.contentDigest, signal);
            if (!install && before === 'absent') continue;
            const entry: ReloadSkill = { world: owner.name, target: `${owner.target.host}${owner.target.podmanContainer ? ` · container ${owner.target.podmanContainer}` : ''}${owner.target.configFile ? ` · SSH config ${owner.target.configFile}` : ''}`, name, before,
              action: !install ? 'remove' : before === 'absent' ? 'add' : before.split(':')[0] === install.revision ? 'unchanged' : 'update',
              source: desired.find(skill => skill.name === name)?.source, after: install?.revision,
              files: await inspectSkillChanges(owner.target, name, before, install?.manifest ?? '', signal) };
            target.skills.push(entry); view.skills.push(entry);
          }
        } catch (error) { view.errors.push(`${owner.name}: ${message(error)}`); }
      }
      this.plan = { preview: view, ...next, targets, expires: Date.now() + 10 * 60 * 1000 };
    } catch (error) {
      view.errors.push(message(error));
      await Promise.all(targets.map(target => target.prepared.dispose()));
    } finally { this.busy = false; }
    return view;
  }
  private async applyPlan(id: string): Promise<ReloadResult> {
    const plan = this.plan;
    if (this.busy || !plan || id !== plan.preview.id || Date.now() > plan.expires) throw new Error('Preview expired; preview again');
    if (plan.preview.errors.length) throw new Error('Resolve preview errors before applying');
    this.busy = true;
    const result: ReloadResult = { applied: false, results: [] };
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(300000)]);
    this.progress = { completed: 0, total: plan.preview.skills.length, current: undefined };
    try {
      return await this.sync.exclusive(async () => {
        if ((await this.read()).digest !== plan.digest) throw new Error('Worlds config changed since preview; preview again');
        await this.ctx.worldPortableWorkspaces.validateCatalog(plan.worlds);
        // Check every destination before the first write. Each write checks again under its lock.
        for (const target of plan.targets) for (const skill of target.skills) {
          if (await inspectSkill(target.world.target, skill.name, signal) !== skill.before) throw new Error(`${skill.world}/${skill.name} changed since preview; preview again`);
        }
        if ((await this.read()).digest !== plan.digest) throw new Error('Worlds config changed since preview; preview again');
        this.sync.blocked = true;
        for (const target of plan.targets) {
          let failed = false;
          for (const skill of target.skills) {
            if (failed) {
              result.results.push({ world: skill.world, skill: skill.name, ok: false, error: 'Not attempted after an earlier failure on this target' });
              continue;
            }
            this.progress.current = `${skill.world} / ${skill.name}`;
            try {
              if (skill.action === 'unchanged') {
                if (await inspectSkill(target.world.target, skill.name, signal) !== skill.before) throw new Error('Skill changed since preview; preview again');
              } else if (skill.action === 'remove') await removeSkill(target.world.target, skill.name, skill.before, signal);
              else await deployPrepared(target.world.target, { ...target.prepared, selected: target.prepared.selected.filter(item => item.name === skill.name) }, signal, new Map([[skill.name, skill.before]]));
              result.results.push({ world: skill.world, skill: skill.name, ok: true });
            } catch (error) { result.results.push({ world: skill.world, skill: skill.name, ok: false, error: message(error) }); failed = true; }
            this.progress.completed++;
          }
        }
        if (signal.aborted) result.results.push({ world: 'Worlds', skill: 'catalog', ok: false, error: 'Reload interrupted; preview again' });
        if (result.results.every(item => item.ok)) {
          await this.ctx.worldPortableWorkspaces.replaceCatalog(plan.worlds);
          this.sync.replace(plan.worlds);
          this.worlds = structuredClone(plan.worlds); this.baseline = plan.digest; this.generation++;
          this.sync.blocked = false; result.applied = true;
        }
        return result;
      });
    } finally { this.busy = false; this.progress.current = undefined; await this.cancel(id); }
  }
  async dispose() {
    clearInterval(this.expiry); this.lifecycle.abort();
    await Promise.allSettled(this.pending ? [this.pending] : []);
    if (this.plan) { await Promise.all(this.plan.targets.map(target => target.prepared.dispose())); this.plan = undefined; }
  }
}
