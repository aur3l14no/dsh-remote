/** World-qualified facade over native local membership and durable SSH workspace records. */
import { Service, type Context } from '@deepseek-ai/cordis';
import { WorkspaceRegistry, WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace';
import { defineDomain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { worldDefinition, workspaceFor, sameWorkspace, worldFingerprint, type WorkspaceDefinition, type WorldDefinition, type WorldTarget } from '../../../world/execution-world/src/identity.ts';
import { worldCommand } from '../../../world/execution-world/src/command.ts';
import { WorkspacePresentation, worldView } from './presentation.ts';
import '../../../world/execution-world/src/worlds.ts';
import type { SkillInstall } from '../../../skill/remote-skills/src/deploy.ts';

export interface CatalogWorld {
  id: string;
  name: string;
  target: WorldTarget;
  skills?: SkillInstall[];
  color?: string;
  enabledSkills?: string[];
  workspaces?: { name?: string; path: string }[];
}
export const LOCAL_WORLD_ID = 'local';
const executionId = (id: string): string => `workspace:${id}`;
export interface Config { worlds: CatalogWorld[] }
declare module '@deepseek-ai/cordis' { interface Context { nativeWorkspaceRegistry: WorkspaceRegistry } }
const targetSchema = z.unknown().transform(worldDefinition);
const recordSchema = z.object({
  id: z.string(), worldId: z.string(), worldName: z.string(), environment: targetSchema,
  path: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), sessionIds: z.array(z.string()), deleted: z.boolean().default(false),
}).strict().refine(row => row.worldId === row.environment.id && row.environment.kind === 'ssh', 'Workspace record must belong to its saved SSH World');
type Record = z.infer<typeof recordSchema>;
const stateSchema = z.object({ workspaces: z.array(recordSchema) }).strict();
type State = z.infer<typeof stateSchema>;
const spec = defineDomain({ name: 'portable_workspaces', version: 1,
  global: { schema: stateSchema, initial: { workspaces: [] } }, tables: {} });

declare module '@deepseek-ai/cordis' { interface Context { worldPortableWorkspaces: WorldPortableWorkspaceRegistry } }

export function parseCatalog(worlds: CatalogWorld[]) {
  if (!Array.isArray(worlds)) throw new Error('worlds.json requires a worlds array');
  const catalog = new Map<string, { name: string; environment: WorldDefinition; color?: string; enabledSkills?: string[]; workspaces?: { name?: string; path: string }[] }>();
  for (const world of worlds) {
    if ((world.id === LOCAL_WORLD_ID) !== (world.target?.kind === 'local')) throw new Error('The reserved World id local identifies This computer');
    if (world.target?.kind === 'local' && (world.skills !== undefined || world.enabledSkills !== undefined)) throw new Error('Local Worlds use native skills; remote deployment fields are not allowed');
    if (typeof world.id !== 'string' || !world.id.trim() || typeof world.name !== 'string' || !world.name.trim()) throw new Error('World id and name are required');
    if (world.enabledSkills !== undefined && (!Array.isArray(world.enabledSkills)
      || world.enabledSkills.some(name => !world.skills?.some(skill => skill.name === name)))) {
      throw new Error('Unknown configured skill selection');
    }
    if (world.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(world.color)) throw new Error('Invalid World color');
    if (world.workspaces !== undefined && (!Array.isArray(world.workspaces)
      || world.workspaces.some(item => !item || typeof item.path !== 'string' || !item.path.startsWith('/')
        || /[\0\r\n]/.test(item.path) || (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim()))))) {
      throw new Error('Workspaces require absolute paths and nonempty names');
    }
    if (new Set(world.workspaces?.map(item => item.path)).size !== (world.workspaces?.length ?? 0)) throw new Error('Duplicate configured workspace path');
    if (catalog.has(world.id)) throw new Error('Duplicate catalog World');
    catalog.set(world.id, { name: world.name, color: world.color, enabledSkills: world.enabledSkills, workspaces: world.workspaces, environment: worldDefinition({ ...world.target, id: world.id }) });
  }
  if (!catalog.has(LOCAL_WORLD_ID)) catalog.set(LOCAL_WORLD_ID, { name: 'This computer', environment: worldDefinition({ id: LOCAL_WORLD_ID, kind: 'local' }), workspaces: [] });
  return catalog;
}

/** Unifies workspace identity and selection without taking ownership of Session logs. */
export default class WorldPortableWorkspaceRegistry extends WorkspaceRegistry {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions', 'executionWorlds', 'nativeWorkspaceRegistry'];
  private portableWorkspaceGlobal?: DomainGlobal<State>;
  private presentation!: WorkspacePresentation;
  private portableWorkspaceTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private get native(): WorkspaceRegistry { return this.ctx.nativeWorkspaceRegistry; }
  private async registerLocalChoices(choices: { name?: string; path: string }[]) {
    for (const configured of choices) {
      const workspace = await this.native.create(configured.path, configured.name);
      if (configured.name !== undefined && configured.name !== workspace.title) await workspace.setTitle(configured.name);
    }
  }
  private localChoices() { return this.native.list().map(row => ({ name: row.title, path: row.path })); }
  worlds() {
    const display = new Map(this.catalog);
    for (const row of this.records()) if (!display.has(row.worldId)) display.set(row.worldId, { name: row.worldName, environment: row.environment, workspaces: [] });
    return [...display].map(([id, world]) => worldView({ id, name: world.name, kind: world.environment.kind,
      color: world.color, choices: world.environment.kind === 'local' ? this.localChoices() : world.workspaces },
    world.environment.kind === 'local' ? this.native.list() : this.records().filter(row => row.worldId === id && !row.deleted),
    this.presentation.pinnedSessionIds));
  }
  enabledSkills(id: string): string[] | undefined { return this.environment(id).enabledSkills; }
  world(id: WorkspaceId) {
    if (this.native.get(id)) return { id: LOCAL_WORLD_ID, name: this.catalog.get(LOCAL_WORLD_ID)!.name };
    const row = this.row(id); return { id: row.worldId, name: row.worldName }; }
  forSession(id: SessionId) {
    const row = this.records().find(row => row.sessionIds.includes(id));
    if (row) return this.get(WorkspaceId(row.id));
    const saved = this.ctx.executionWorlds.bindings.get(id);
    if (saved?.kind !== 'local') return undefined;
    const native = this.native.list().find(row => row.sessionIds.includes(id));
    return native && this.get(native.id);
  }
  /** Resolve descendant context without making children top-level Workspace members. */
  async contextForSession(id: SessionId, signal?: AbortSignal): Promise<Workspace> {
    const visited = new Set<SessionId>();
    const bindings: WorkspaceDefinition[] = [];
    let current = id;
    for (;;) {
      signal?.throwIfAborted();
      if (visited.has(current)) throw new RemoteError('WORLD_MISMATCH', 'Cyclic Session lineage');
      visited.add(current);
      const saved = this.ctx.executionWorlds.bindings.get(current);
      if (!saved) throw new RemoteError('WORLD_REQUIRED', 'Session lineage has no saved World binding');
      bindings.push(saved);
      const header = this.ctx.sessions.get(current)?.header
        ?? (await this.ctx.sessionPersistence.stat(current, { signal }))?.header;
      signal?.throwIfAborted();
      if (!header || header.cwd !== saved.cwd) {
        throw new RemoteError('WORLD_MISMATCH', 'Session is absent or its cwd differs from the saved binding');
      }
      const explicitParent = this.ctx.executionWorlds.bindings.explicitParent(current);
      if (explicitParent !== undefined) {
        if (header.origin !== 'subagent' || header.parentSession !== explicitParent
          || !this.ctx.executionWorlds.bindings.get(explicitParent)) {
          throw new RemoteError('WORLD_MISMATCH', 'Invalid explicit child lineage');
        }
        const workspace = this.list().find(workspace => executionId(workspace.id) === saved.id);
        if (!workspace || bindings.some(binding => !sameWorkspace(binding, this.definition(workspace.id)))) {
          throw new RemoteError('WORLD_MISMATCH', 'Explicit child workspace is absent or changed');
        }
        return workspace;
      }
      const workspace = this.forSession(current);
      if (workspace) {
        if (header.origin === 'subagent') throw new RemoteError('WORLD_MISMATCH', 'Subagent cannot be a top-level workspace member');
        const expected = this.definition(workspace.id);
        if (bindings.some(binding => !sameWorkspace(binding, expected))) {
          throw new RemoteError('WORLD_MISMATCH', 'Session lineage crosses portable workspaces');
        }
        return workspace;
      }
      if (header.origin !== 'subagent' || !header.parentSession) {
        throw new RemoteError('WORLD_REQUIRED', 'Remote context requires saved portable_workspace membership or subagent lineage');
      }
      current = header.parentSession;
    }
  }
  private catalog = new Map<string, { name: string; environment: WorldDefinition; color?: string; enabledSkills?: string[]; workspaces?: { name?: string; path: string }[] }>();

  constructor(ctx: Context, config: Config) {
    super(ctx);
    this.catalog = parseCatalog(config.worlds);
    ctx.provide('worldPortableWorkspaces', this);
  }

  async validateCatalog(worlds: CatalogWorld[]) {
    const next = parseCatalog(worlds);
    for (const [id, world] of next) {
      const saved = this.catalog.get(id)?.environment ?? this.records().find(row => row.worldId === id)?.environment;
      if (saved && worldFingerprint(saved) !== worldFingerprint(world.environment)) throw new Error(`World ${id}: target changed; use a new World id`);
    }
    const local = next.get(LOCAL_WORLD_ID)!;
    if (local.workspaces?.length) {
      const owner = await this.ctx.executionWorlds.prepareWorld(workspaceFor(local.environment, 'selection:local', '/'));
      const seen = new Set<string>();
      for (const workspace of local.workspaces) {
        const target = await owner.fs.resolve(workspace.path);
        if ((await owner.fs.stat(target))?.type !== 'directory') throw new RemoteError('NOT_DIRECTORY', 'Configured local workspace must be an existing directory');
        const canonical = owner.fs.processPath(target);
        if (seen.has(canonical)) throw new RemoteError('INVALID_ARGUMENT', 'Configured local workspaces resolve to the same directory');
        seen.add(canonical);
      }
    }
  }
  async replaceCatalog(worlds: CatalogWorld[]) {
    await this.validateCatalog(worlds);
    const next = parseCatalog(worlds);
    await this.registerLocalChoices(next.get(LOCAL_WORLD_ID)!.workspaces ?? []);
    this.catalog = next;
    this.changed();
  }

  protected override async [Service.init](): Promise<void> {
    // The separate native registry owns its domain; this facade initializes only its metadata.
    const domain = await this.ctx.storageDomain.open(spec);
    this.ctx.effect(() => () => domain.close());
    this.portableWorkspaceGlobal = domain.global;
    this.presentation = await WorkspacePresentation.open(this.ctx, () => this.changed());
    const rows = this.records();
    if (rows.some(row => this.native.get(WorkspaceId(row.id)))) throw new Error('Local and SSH workspace identities collide');
    await this.registerLocalChoices(this.catalog.get(LOCAL_WORLD_ID)!.workspaces ?? []);
    if (new Set(rows.map(row => row.id)).size !== rows.length
        || new Set(rows.map(row => JSON.stringify([row.worldId, row.path]))).size !== rows.length) {
      throw new Error('Duplicate PortableWorkspace identity');
    }
  }

  private records(): Record[] {
    if (!this.portableWorkspaceGlobal) throw new Error('PortableWorkspace registry is not ready');
    return this.portableWorkspaceGlobal.get().workspaces;
  }
  private row(id: WorkspaceId): Record {
    const row = this.records().find(row => row.id === id);
    if (!row) throw new RemoteError('PORTABLE_WORKSPACE_NOT_FOUND', 'Unknown PortableWorkspace');
    return row;
  }
  private mutate(operation: (rows: Record[]) => Promise<Record[]>): Promise<void> {
    const pending = this.portableWorkspaceTail.then(async () => {
      const portableWorkspaces = await operation(this.records());
      await this.portableWorkspaceGlobal!.set({ workspaces: portableWorkspaces });
      this.changed();
    });
    this.portableWorkspaceTail = pending.catch(() => {});
    return pending;
  }
  private environment(id: string, saved?: WorldDefinition) {
    const world = this.catalog.get(id);
    if (!world) throw new RemoteError('WORLD_REQUIRED', 'PortableWorkspace World is absent from the catalog');
    if (saved && worldFingerprint(saved) !== worldFingerprint(world.environment)) {
      throw new RemoteError('WORLD_MISMATCH', 'PortableWorkspace connection changed; select a new World identity explicitly');
    }
    return world;
  }

  executionTargets() {
    return [...this.catalog].map(([id, world]) => ({ id, name: world.name, kind: world.environment.kind }));
  }

  /** Create and register a private workspace for explicitly delegated SSH work. */
  async createScratchInWorld(worldId: string, signal: AbortSignal): Promise<Workspace> {
    const world = this.environment(worldId);
    if (world.environment.kind !== 'ssh') throw new RemoteError('INVALID_WORLD', 'Scratch workspaces require an SSH target');
    signal.throwIfAborted();
    const owner = await this.ctx.executionWorlds.prepareWorld(workspaceFor(world.environment, `selection:${worldId}`, '/'));
    const path = await worldCommand(owner, '/', ['mktemp', '-d', '/tmp/dsh-workspace.XXXXXXXXXX'], signal);
    if (!/^\/tmp\/dsh-workspace\.[A-Za-z0-9]+$/.test(path)) throw new RemoteError('INVALID_WORLD', 'Target returned an invalid scratch path');
    signal.throwIfAborted();
    return this.createInWorld(worldId, path);
  }

  async createInWorld(worldId: string, path: string): Promise<Workspace> {
    if (!path.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Absolute workspace path required');
    const world = this.environment(worldId);
    if (world.environment.kind === 'local') {
      const configured = world.workspaces?.find(item => item.path === path);
      const workspace = await this.native.create(path, configured?.name);
      this.changed();
      return this.get(workspace.id)!;
    }
    const owner = await this.ctx.executionWorlds.prepareWorld(workspaceFor(world.environment, `selection:${worldId}`, '/'));
    const target = await owner.fs.resolve(path);
    if ((await owner.fs.stat(target))?.type !== 'directory') throw new RemoteError('NOT_DIRECTORY', 'Workspace must be an existing remote directory');
    const canonical = owner.fs.processPath(target);
    const configured = world.workspaces?.find(item => item.path === path);
    let id: string | undefined;
    await this.mutate(async rows => {
      this.environment(worldId, world.environment);
      const existing = rows.find(row => row.worldId === worldId && row.path === canonical);
      if (existing) { this.environment(worldId, existing.environment); id = existing.id; return rows.map(row => row.id === existing.id ? { ...row, deleted: false } : row); }
      id = randomUUID();
      const now = new Date().toISOString();
      return [...rows, { id, worldId, worldName: world.name, environment: world.environment,
        path: canonical, title: `${world.name} · ${configured?.name ?? (posix.basename(canonical) || canonical)}`, createdAt: now, updatedAt: now, sessionIds: [], deleted: false }];
    });
    return this.get(WorkspaceId(id!))!;
  }

  definition(id: WorkspaceId): WorkspaceDefinition {
    const local = this.native.get(id);
    if (local) return workspaceFor(worldDefinition({ id: LOCAL_WORLD_ID, kind: 'local' }), executionId(id), local.path);
    const row = this.row(id);
    // Saved bindings remain authoritative when a catalog entry is retired.
    if (this.catalog.has(row.worldId)) this.environment(row.worldId, row.environment);
    return workspaceFor(row.environment, executionId(row.id), row.path);
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
    if (!saved || !sameWorkspace(saved, expected)) throw new RemoteError('WORLD_MISMATCH', 'Session belongs to another World or workspace');
    const header = this.ctx.sessions.get(sessionId)?.header
      ?? (await this.ctx.sessionPersistence.list()).find(snapshot => snapshot.header.id === sessionId)?.header;
    if (!header || header.cwd !== expected.cwd || header.origin === 'subagent') {
      throw new RemoteError('WORLD_MISMATCH', 'Session is absent, changed workspace, or belongs to subagent routing');
    }
    await this.validate(id);
  }

  override get(id: WorkspaceId): Workspace | undefined {
    const native = this.native.get(id);
    if (native) return this.localWorkspace(native);
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
  private localWorkspace(native: Workspace): Workspace {
    const registry = this;
    const change = async (operation: () => Promise<void>) => { await operation(); registry.changed(); };
    return {
      get id() { return native.id; }, get path() { return native.path; }, get title() { return native.title; },
      get createdAt() { return native.createdAt; }, get updatedAt() { return native.updatedAt; },
      get sessionIds() { return native.sessionIds.filter(id => {
        const saved = registry.ctx.executionWorlds.bindings.get(id);
        return saved?.kind === 'local' && sameWorkspace(saved, registry.definition(native.id));
      }); },
      status: () => native.status(),
      setTitle: title => change(() => native.setTitle(title)),
      async attachSession(id) { await registry.validateSession(native.id, id); await change(() => native.attachSession(id)); },
      async detachSession() { throw new RemoteError('WORLD_MISMATCH', 'Session membership is immutable; archive the Session instead'); },
      insertSessionBefore: (id, before) => change(() => native.insertSessionBefore(id, before)),
    };
  }
  private update(id: WorkspaceId, change: (row: Record) => Record): Promise<void> {
    return this.mutate(async rows => {
      this.row(id);
      return rows.map(row => row.id === id ? { ...change(row), updatedAt: new Date().toISOString() } : row);
    });
  }
  override list(): Workspace[] { return [...this.native.list().map(row => this.localWorkspace(row)), ...this.records().filter(row => !row.deleted).map(row => this.get(WorkspaceId(row.id))!)]; }
  override async create(_path: string): Promise<Workspace> { throw new RemoteError('WORLD_REQUIRED', 'Workspace creation requires an explicit World'); }
  override async resolveByPath(_path: string): Promise<Workspace | undefined> { throw new RemoteError('WORLD_REQUIRED', 'A path alone cannot identify a PortableWorkspace'); }
  override async delete(id: WorkspaceId): Promise<boolean> {
    if (this.native.get(id)) { const removed = await this.native.delete(id); this.changed(); return removed; }
    if (!this.get(id)) return false;
    await this.update(id, row => ({ ...row, deleted: true }));
    return true;
  }
  override async insertBefore(id: WorkspaceId, before?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    if (this.native.get(id)) {
      if (before !== undefined && !this.native.get(before)) throw new RemoteError('WORLD_MISMATCH', 'Workspace order is per environment');
      await this.native.insertBefore(id, before); this.changed(); return this.list().map(row => row.id);
    }
    await this.mutate(async rows => {
      const ids = move(rows.filter(row => !row.deleted).map(row => row.id), id, before);
      return [...ids.map(id => rows.find(row => row.id === id)!), ...rows.filter(row => row.deleted)];
    });
    return this.list().map(row => row.id);
  }
  override get archivedSessionIds(): readonly SessionId[] {
    return [...new Set([...this.native.archivedSessionIds, ...this.presentation.archivedSessionIds.map(SessionId)])];
  }
  async pinSession(id: SessionId, pinned: boolean): Promise<void> {
    if (!this.forSession(id)) throw new RemoteError('INVALID_ARGUMENT', 'Unknown Session membership');
    if (pinned && this.archivedSessionIds.includes(id)) throw new RemoteError('INVALID_ARGUMENT', 'Archived Sessions cannot be pinned');
    await this.presentation.pin(id, pinned);
  }
  override async archiveSession(id: SessionId): Promise<void> {
    const workspace = this.forSession(id);
    if (!workspace) throw new RemoteError('INVALID_ARGUMENT', 'Unknown Session membership');
    if (this.native.get(workspace.id)) await this.native.archiveSession(id);
    await this.presentation.archive(id);
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
