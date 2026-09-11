/** Host-owned display preferences, independent of execution identity and membership. */
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { WorldView } from './contracts.ts';

const schema = z.object({ pinnedSessionIds: z.array(z.string()), archivedSessionIds: z.array(z.string()) }).strict();
type Preferences = z.infer<typeof schema>;
const spec = defineDomain({ name: 'workspace_presentation', version: 1,
  global: { schema, initial: { pinnedSessionIds: [], archivedSessionIds: [] } }, tables: {} });

export class WorkspacePresentation {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly state: DomainGlobal<Preferences>, private readonly changed: () => void) {}
  static async open(ctx: Context, changed: () => void) {
    const domain = await ctx.storageDomain.open(spec);
    ctx.effect(() => () => domain.close());
    return new WorkspacePresentation(domain.global, changed);
  }
  get pinnedSessionIds(): readonly string[] { return this.state.get().pinnedSessionIds; }
  get archivedSessionIds(): readonly string[] { return this.state.get().archivedSessionIds; }
  private update(change: (state: Preferences) => Preferences) {
    const pending = this.tail.then(async () => { await this.state.set(change(this.state.get())); this.changed(); });
    this.tail = pending.catch(() => {});
    return pending;
  }
  pin(id: string, pinned: boolean) {
    return this.update(state => {
      if (pinned && state.archivedSessionIds.includes(id)) throw new Error('Archived Sessions cannot be pinned');
      return { ...state, pinnedSessionIds: pinned ? [id, ...state.pinnedSessionIds.filter(value => value !== id)]
        : state.pinnedSessionIds.filter(value => value !== id) };
    });
  }
  archive(id: string) {
    return this.update(state => ({ archivedSessionIds: [...new Set([...state.archivedSessionIds, id])],
      pinnedSessionIds: state.pinnedSessionIds.filter(value => value !== id) }));
  }
}

interface DisplayWorkspace { id: string; path: string; title: string; sessionIds: readonly string[] }
interface DisplayWorld { id: string; name: string; kind: 'local' | 'ssh'; color?: string; choices?: { name?: string; path: string }[] }
/** The caller supplies authoritative membership; display fields never grant execution access. */
export function worldView(world: DisplayWorld, workspaces: DisplayWorkspace[], pinned: readonly string[]): WorldView {
  const sessions = new Set(workspaces.flatMap(row => [...row.sessionIds]));
  return { id: world.id, kind: world.kind, name: world.name, color: world.color ?? '#60a5fa',
    workspaceIds: workspaces.map(row => row.id), pinnedSessionIds: pinned.filter(id => sessions.has(id)),
    workspaces: world.choices ?? workspaces.map(row => ({ name: row.title.startsWith(world.name + ' · ')
      ? row.title.slice(world.name.length + 3) : row.title, path: row.path })) };
}
