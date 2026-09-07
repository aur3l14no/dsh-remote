import { type Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceFeedSource } from '@deepseek-ai/dsh-api-workspace-controller';
import type { WorkspaceFollowFrame, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types';
import { contribution } from './wire.ts';
import type { PortableWorkspaceSelection, WorldView } from './contracts.ts';
import './registry.ts';


export class PortableWorkspaceApi extends TypertRemoteService {
  static inject = ['typert', 'worldPortableWorkspaces'];
  constructor(ctx: Context) {
    super(ctx, 'portableWorkspaceApi', { namespace: 'portableWorkspace' });
    ctx.effect(() => ctx.typert.register(contribution));
  }
  @Remote('worlds')
  worlds(): WorldView[] { return this.ctx.worldPortableWorkspaces.worlds(); }
  @Remote('create')
  async create(request: PortableWorkspaceSelection) {
    const workspace = await this.ctx.worldPortableWorkspaces.createInWorld(request.worldId, request.path);
    return { workspaceId: workspace.id };
  }
}

/** Reuse native mutation contracts, but observe our own durable registry rather than its local domain. */
export class PortableWorkspaceFeed implements WorkspaceFeedSource {
  constructor(private readonly ctx: Context) {}
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    const registry = this.ctx.get('worldPortableWorkspaces');
    if (!registry) throw new Error('PortableWorkspace registry is not ready');
    let dirty = true;
    let wake: (() => void) | undefined;
    const changed = () => { dirty = true; wake?.(); };
    const unsubscribe = registry.subscribe(changed);
    signal.addEventListener('abort', changed);
    try {
      // Coalesce mutations, then diff authoritative snapshots into the native one-baseline-per-generation stream.
      let previous = new Map<string, WorkspaceView>();
      let first = true;
      while (!signal.aborted) {
        if (!dirty) await new Promise<void>(accept => { wake = accept; });
        wake = undefined;
        if (signal.aborted) break;
        dirty = false;
        const items = registry.list().map(workspace => ({ workspaceId: workspace.id, path: workspace.path,
          title: workspace.title, sessionIds: [...workspace.sessionIds],
          createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }));
        if (first) {
          first = false;
          yield { type: 'baseline', value: { items, archivedSessionIds: [...registry.archivedSessionIds] } };
        } else {
          const nextIds = new Set(items.map(row => row.workspaceId));
          for (const row of previous.values()) if (!nextIds.has(row.workspaceId)) yield { type: 'remove', workspaceId: row.workspaceId };
          for (const row of items) if (JSON.stringify(previous.get(row.workspaceId)) !== JSON.stringify(row)) yield { type: 'upsert', workspace: row };
          yield { type: 'order', workspaceIds: items.map(row => row.workspaceId) };
          yield { type: 'archived', archivedSessionIds: [...registry.archivedSessionIds] };
        }
        previous = new Map(items.map(row => [row.workspaceId, row]));
      }
    } finally { unsubscribe(); signal.removeEventListener('abort', changed); }
  }
}
