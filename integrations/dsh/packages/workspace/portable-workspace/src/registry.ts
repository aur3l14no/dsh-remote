/** Durable World-qualified workspace registry; workspace files never live in the host registry. */
import { Service, type Context } from '@deepseek-ai/cordis';
import { WorkspaceRegistry, WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace';
import { defineDomain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { worldDefinition, type WorldDefinition } from '../../../world/ssh-world/src/bindings.ts';
import '../../../world/ssh-world/src/worlds.ts';
import type { SkillInstall } from '../../../skill/remote-skills/src/deploy.ts';

export interface CatalogWorld {
  id: string;
  name: string;
  target: Omit<WorldDefinition, 'id' | 'cwd'>;
  skills?: SkillInstall[];
}
export interface Config { worlds: CatalogWorld[] }
const targetSchema = z.unknown().transform(worldDefinition);
const recordSchema = z.object({
  id: z.string(), worldId: z.string(), worldName: z.string(), environment: targetSchema,
  path: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), sessionIds: z.array(z.string()), deleted: z.boolean().default(false),
}).strict();
type Record = z.infer<typeof recordSchema>;
// Persisted v1 names are frozen so existing metadata and immutable Session bindings still resolve.
// These three strings are storage compatibility, not public service or domain terminology.
const recordsKey = 'projects';
const domainName = 'remote_project_experiment';
const bindingPrefix = 'project-';
const stateSchema = z.object({ [recordsKey]: z.array(recordSchema), archivedSessionIds: z.array(z.string()).default([]) }).strict();
type State = z.infer<typeof stateSchema>;
const spec = defineDomain({ name: domainName, version: 1,
  global: { schema: stateSchema, initial: { [recordsKey]: [], archivedSessionIds: [] } }, tables: {} });

declare module '@deepseek-ai/cordis' { interface Context { worldPortableWorkspaces: WorldPortableWorkspaceRegistry } }

/** Replaces only the Workspace service. No local workspace lookup or Session storage. */
export default class WorldPortableWorkspaceRegistry extends WorkspaceRegistry {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions', 'executionWorlds'];
  private portableWorkspaceGlobal?: DomainGlobal<State>;
  private portableWorkspaceTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  worlds() { return [...this.catalog].map(([id, world]) => ({ id, name: world.name })); }
  world(id: WorkspaceId) { const row = this.row(id); return { id: row.worldId, name: row.worldName }; }
  forSession(id: SessionId) { const row = this.records().find(row => row.sessionIds.includes(id)); return row && this.get(WorkspaceId(row.id)); }
  /** Resolve descendant context without making children top-level Workspace members. */
  async contextForSession(id: SessionId): Promise<Workspace> {
    const visited = new Set<SessionId>();
    const bindings: WorldDefinition[] = [];
    let persisted: Awaited<ReturnType<Context['sessionPersistence']['list']>> | undefined;
    let current = id;
    for (;;) {
      if (visited.has(current)) throw new RemoteError('WORLD_MISMATCH', 'Cyclic Session lineage');
      visited.add(current);
      const saved = this.ctx.executionWorlds.bindings.get(current);
      if (!saved) throw new RemoteError('WORLD_REQUIRED', 'Session lineage has no saved World binding');
      bindings.push(saved);
      const workspace = this.forSession(current);
      if (workspace) {
        const expected = this.definition(workspace.id);
        if (bindings.some(binding => JSON.stringify(binding) !== JSON.stringify(expected))) {
          throw new RemoteError('WORLD_MISMATCH', 'Session lineage crosses portable workspaces');
        }
        return workspace;
      }
      let header = this.ctx.sessions.get(current)?.header;
      if (!header) {
        persisted ??= await this.ctx.sessionPersistence.list();
        header = persisted.find(row => row.header.id === current)?.header;
      }
      if (!header || header.origin !== 'subagent' || !header.parentSession || header.cwd !== saved.cwd) {
        throw new RemoteError('WORLD_REQUIRED', 'Remote context requires saved portable_workspace membership or subagent lineage');
      }
      current = header.parentSession;
    }
  }
  private catalog = new Map<string, { name: string; environment: WorldDefinition }>();

  constructor(ctx: Context, config: Config) {
    super(ctx);
    for (const world of config.worlds) {
      if (this.catalog.has(world.id)) throw new Error('Duplicate catalog World');
      this.catalog.set(world.id, { name: world.name, environment: worldDefinition({ ...world.target, id: world.id, cwd: '/' }) });
    }
    ctx.provide('worldPortableWorkspaces', this);
  }

  protected override async [Service.init](): Promise<void> {
    // Deliberately do not initialize the built-in local Workspace domain/indexer.
    const domain = await this.ctx.storageDomain.open(spec);
    this.ctx.effect(() => () => domain.close());
    this.portableWorkspaceGlobal = domain.global;
    const rows = this.records();
    if (new Set(rows.map(row => row.id)).size !== rows.length
        || new Set(rows.map(row => JSON.stringify([row.worldId, row.path]))).size !== rows.length) {
      throw new Error('Duplicate PortableWorkspace identity');
    }
  }

  private records(): Record[] {
    if (!this.portableWorkspaceGlobal) throw new Error('PortableWorkspace registry is not ready');
    return this.portableWorkspaceGlobal.get()[recordsKey];
  }
  private row(id: WorkspaceId): Record {
    const row = this.records().find(row => row.id === id);
    if (!row) throw new RemoteError('PORTABLE_WORKSPACE_NOT_FOUND', 'Unknown PortableWorkspace');
    return row;
  }
  private mutate(operation: (rows: Record[]) => Promise<Record[]>, changeState: (state: State) => State = state => state): Promise<void> {
    const pending = this.portableWorkspaceTail.then(async () => {
      const portableWorkspaces = await operation(this.records());
      await this.portableWorkspaceGlobal!.set(changeState({ ...this.portableWorkspaceGlobal!.get(), [recordsKey]: portableWorkspaces }));
      for (const listener of this.listeners) listener();
    });
    this.portableWorkspaceTail = pending.catch(() => {});
    return pending;
  }
  private environment(id: string, saved?: WorldDefinition) {
    const world = this.catalog.get(id);
    if (!world) throw new RemoteError('WORLD_REQUIRED', 'PortableWorkspace World is absent from the catalog');
    if (saved && JSON.stringify(saved) !== JSON.stringify(world.environment)) {
      throw new RemoteError('WORLD_MISMATCH', 'PortableWorkspace connection changed; select a new World identity explicitly');
    }
    return world;
  }

  async createInWorld(worldId: string, path: string): Promise<Workspace> {
    if (!path.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Absolute workspace path required');
    const world = this.environment(worldId);
    const hash = createHash('sha256').update(JSON.stringify(world.environment)).digest('hex');
    const owner = await this.ctx.executionWorlds.prepareWorld({ ...world.environment, id: `catalog-${hash}` });
    const target = await owner.fs.resolve(path);
    if ((await owner.fs.stat(target))?.type !== 'directory') throw new RemoteError('NOT_DIRECTORY', 'Workspace must be an existing remote directory');
    const canonical = owner.fs.processPath(target);
    let id: string | undefined;
    await this.mutate(async rows => {
      const existing = rows.find(row => row.worldId === worldId && row.path === canonical);
      if (existing) { this.environment(worldId, existing.environment); id = existing.id; return rows.map(row => row.id === existing.id ? { ...row, deleted: false } : row); }
      id = randomUUID();
      const now = new Date().toISOString();
      return [...rows, { id, worldId, worldName: world.name, environment: world.environment,
        path: canonical, title: `${world.name} · ${posix.basename(canonical) || canonical}`, createdAt: now, updatedAt: now, sessionIds: [], deleted: false }];
    });
    return this.get(WorkspaceId(id!))!;
  }

  definition(id: WorkspaceId): WorldDefinition {
    const row = this.row(id);
    this.environment(row.worldId, row.environment);
    // Old v1 bindings keep their meaning. Catalog IDs and concrete workspace IDs are distinct.
    return worldDefinition({ ...row.environment, id: `${bindingPrefix}${row.id}`, cwd: row.path });
  }
  async validate(id: WorkspaceId): Promise<void> {
    const definition = this.definition(id);
    const owner = await this.ctx.executionWorlds.prepareWorld(definition);
    const target = await owner.fs.resolve(definition.cwd);
    if (owner.fs.processPath(target) !== definition.cwd || (await owner.fs.stat(target))?.type !== 'directory') {
      throw new RemoteError('WORLD_MISMATCH', 'Saved workspace is missing or changed canonical identity');
    }
  }
  async validateSession(id: WorkspaceId, sessionId: SessionId): Promise<void> {
    const expected = this.definition(id);
    const saved = this.ctx.executionWorlds.bindings.get(sessionId);
    if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new RemoteError('WORLD_MISMATCH', 'Session belongs to another World or workspace');
    const header = this.ctx.sessions.get(sessionId)?.header
      ?? (await this.ctx.sessionPersistence.list()).find(snapshot => snapshot.header.id === sessionId)?.header;
    if (!header || header.cwd !== expected.cwd || header.origin === 'subagent') {
      throw new RemoteError('WORLD_MISMATCH', 'Session is absent, changed workspace, or belongs to subagent routing');
    }
    await this.validate(id);
  }

  override get(id: WorkspaceId): Workspace | undefined {
    if (!this.records().some(row => row.id === id)) return undefined;
    const registry = this;
    return {
      id,
      get path() { return registry.row(id).path; },
      get title() { return registry.row(id).title; },
      get createdAt() { return registry.row(id).createdAt; },
      get updatedAt() { return registry.row(id).updatedAt; },
      get sessionIds() { return registry.row(id).sessionIds.map(SessionId); },
      async attachSession(sessionId) {
        await registry.validateSession(id, sessionId);
        await registry.mutate(async rows => rows.map(row => row.id !== id || row.sessionIds.includes(sessionId) ? row
          : { ...row, sessionIds: [sessionId, ...row.sessionIds], updatedAt: new Date().toISOString() }));
      },
      async status() { await registry.validate(id); return 'ok'; },
      setTitle: async title => {
        title = title.trim();
        if (!title) throw new RemoteError('INVALID_ARGUMENT', 'Title must not be empty');
        await registry.update(id, row => ({ ...row, title }));
      },
      detachSession: async sessionId => {
        throw new RemoteError('WORLD_MISMATCH', 'Session membership is immutable; archive the Session instead');
      },
      insertSessionBefore: async (sessionId, before) => {
        await registry.update(id, row => ({ ...row, sessionIds: move(row.sessionIds, sessionId, before) }));
      },
    };
  }
  private update(id: WorkspaceId, change: (row: Record) => Record): Promise<void> {
    return this.mutate(async rows => {
      this.row(id);
      return rows.map(row => row.id === id ? { ...change(row), updatedAt: new Date().toISOString() } : row);
    });
  }
  override list(): Workspace[] { return this.records().filter(row => !row.deleted).map(row => this.get(WorkspaceId(row.id))!); }
  override async create(_path: string): Promise<Workspace> { throw new RemoteError('WORLD_REQUIRED', 'PortableWorkspace creation requires World + workspace'); }
  override async resolveByPath(_path: string): Promise<Workspace | undefined> { throw new RemoteError('WORLD_REQUIRED', 'A path alone cannot identify a PortableWorkspace'); }
  override async delete(id: WorkspaceId): Promise<boolean> {
    if (!this.get(id)) return false;
    await this.update(id, row => ({ ...row, deleted: true }));
    return true;
  }
  override async insertBefore(id: WorkspaceId, before?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    await this.mutate(async rows => {
      const ids = move(rows.filter(row => !row.deleted).map(row => row.id), id, before);
      return [...ids.map(id => rows.find(row => row.id === id)!), ...rows.filter(row => row.deleted)];
    });
    return this.list().map(row => row.id);
  }
  override get archivedSessionIds(): readonly SessionId[] { return this.portableWorkspaceGlobal!.get().archivedSessionIds.map(SessionId); }
  override async archiveSession(id: SessionId): Promise<void> {
    if (!this.forSession(id)) throw new RemoteError('INVALID_ARGUMENT', 'Unknown Session membership');
    await this.mutate(async rows => rows, state => state.archivedSessionIds.includes(id)
      ? state : { ...state, archivedSessionIds: [...state.archivedSessionIds, id] });
  }
}

function move<T extends string>(items: readonly T[], id: T, before?: T): T[] {
  if (!items.includes(id) || (before !== undefined && !items.includes(before))) {
    throw new RemoteError('INVALID_ARGUMENT', 'Move requires existing members');
  }
  if (id === before) return [...items];
  const result = items.filter(value => value !== id);
  result.splice(before === undefined ? result.length : result.indexOf(before), 0, id);
  return result;
}
