/** Source-only Project seam experiment; not part of the SSH plugin distribution. */
import { Service, type Context } from '@deepseek-ai/cordis';
import { WorkspaceRegistry, WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace';
import { defineDomain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { RemoteError } from '../../packages/client/src/index.ts';
import { worldDefinition, type WorldDefinition } from '../../packages/dsh-ssh/src/bindings.ts';
import '../../packages/dsh-ssh/src/worlds.ts';

export interface CatalogWorld {
  id: string;
  name: string;
  target: Omit<WorldDefinition, 'id' | 'cwd'>;
}
export interface Config { worlds: CatalogWorld[] }
const targetSchema = z.unknown().transform(worldDefinition);
const recordSchema = z.object({
  id: z.string(), worldId: z.string(), worldName: z.string(), environment: targetSchema,
  path: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), sessionIds: z.array(z.string()),
}).strict();
type Record = z.infer<typeof recordSchema>;
const stateSchema = z.object({ projects: z.array(recordSchema) }).strict();
type State = z.infer<typeof stateSchema>;
const spec = defineDomain({ name: 'remote_project_experiment', version: 1,
  global: { schema: stateSchema, initial: { projects: [] } }, tables: {} });

declare module '@deepseek-ai/cordis' { interface Context { worldProjects: WorldProjectRegistry } }

/** Replaces only the Workspace service. No local workspace lookup or Session storage. */
export default class WorldProjectRegistry extends WorkspaceRegistry {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions', 'executionWorlds'];
  private projectGlobal?: DomainGlobal<State>;
  private projectTail: Promise<unknown> = Promise.resolve();
  private catalog = new Map<string, { name: string; environment: WorldDefinition }>();

  constructor(ctx: Context, config: Config) {
    super(ctx);
    for (const world of config.worlds) {
      if (this.catalog.has(world.id)) throw new Error('Duplicate catalog World');
      this.catalog.set(world.id, { name: world.name, environment: worldDefinition({ ...world.target, id: world.id, cwd: '/' }) });
    }
    ctx.provide('worldProjects', this);
  }

  protected override async [Service.init](): Promise<void> {
    // Deliberately do not initialize the built-in local Workspace domain/indexer.
    const domain = await this.ctx.storageDomain.open(spec);
    this.ctx.effect(() => () => domain.close());
    this.projectGlobal = domain.global;
    const rows = this.records();
    if (new Set(rows.map(row => row.id)).size !== rows.length
        || new Set(rows.map(row => JSON.stringify([row.worldId, row.path]))).size !== rows.length) {
      throw new Error('Duplicate Project identity');
    }
  }

  private records(): Record[] {
    if (!this.projectGlobal) throw new Error('Project registry is not ready');
    return this.projectGlobal.get().projects;
  }
  private row(id: WorkspaceId): Record {
    const row = this.records().find(row => row.id === id);
    if (!row) throw new RemoteError('PROJECT_NOT_FOUND', 'Unknown Project');
    return row;
  }
  private mutate(operation: (rows: Record[]) => Promise<Record[]>): Promise<void> {
    const pending = this.projectTail.then(async () => {
      const projects = await operation(this.records());
      await this.projectGlobal!.set({ projects });
    });
    this.projectTail = pending.catch(() => {});
    return pending;
  }
  private environment(id: string, saved?: WorldDefinition) {
    const world = this.catalog.get(id);
    if (!world) throw new RemoteError('WORLD_REQUIRED', 'Project World is absent from the catalog');
    if (saved && JSON.stringify(saved) !== JSON.stringify(world.environment)) {
      throw new RemoteError('WORLD_MISMATCH', 'Project connection changed; select a new World identity explicitly');
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
      if (existing) { this.environment(worldId, existing.environment); id = existing.id; return rows; }
      id = randomUUID();
      const now = new Date().toISOString();
      return [...rows, { id, worldId, worldName: world.name, environment: world.environment,
        path: canonical, title: posix.basename(canonical) || canonical, createdAt: now, updatedAt: now, sessionIds: [] }];
    });
    return this.get(WorkspaceId(id!))!;
  }

  definition(id: WorkspaceId): WorldDefinition {
    const row = this.row(id);
    this.environment(row.worldId, row.environment);
    // Old v1 bindings keep their meaning. Catalog IDs and concrete workspace IDs are distinct.
    return worldDefinition({ ...row.environment, id: `project-${row.id}`, cwd: row.path });
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
      setTitle: async () => unsupported(), detachSession: async () => unsupported(), insertSessionBefore: async () => unsupported(),
    };
  }
  override list(): Workspace[] { return this.records().map(row => this.get(WorkspaceId(row.id))!); }
  override async create(_path: string): Promise<Workspace> { throw new RemoteError('WORLD_REQUIRED', 'Project creation requires World + workspace'); }
  override async resolveByPath(_path: string): Promise<Workspace | undefined> { throw new RemoteError('WORLD_REQUIRED', 'A path alone cannot identify a Project'); }
  override async delete(): Promise<boolean> { return unsupported(); }
  override async insertBefore(): Promise<readonly WorkspaceId[]> { return unsupported(); }
  override get archivedSessionIds(): readonly SessionId[] { return []; }
  override async archiveSession(): Promise<void> { return unsupported(); }
}

function unsupported(): never { throw new RemoteError('EXPERIMENT_UNSUPPORTED', 'Project mutation is outside this seam experiment'); }
