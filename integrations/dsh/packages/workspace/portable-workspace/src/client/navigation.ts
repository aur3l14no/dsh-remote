import { Service, type Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';

/** World-qualified selection with the native main-panel and navigation lifecycle. */
export class Navigation extends Service implements UiWorkspace {
  unavailableSession?: string;
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>();
  private readonly lifetime = new AbortController();
  private initial = new URL(location.href).searchParams.get('session');
  private get sessions(): ISessions { return this.ctx.get('sessions') as unknown as ISessions; }

  constructor(ctx: Context) {
    super(ctx, 'uiWorkspace');
    const restoring = ctx.layout.beginNavigation();
    const reconcile = () => {
      const snapshot = this.sessions.list.getSnapshot();
      if (this.initial) {
        if (snapshot.phase !== 'ready') return;
        const id = this.initial as SessionId;
        this.initial = null;
        if (!restoring.aborted) {
          if (snapshot.byId[id]) this.openSession(id);
          else this.unavailableSession = id;
          return;
        }
      }
      const current = snapshot.current;
      if (current === undefined && this.unavailableSession) return;
      this.unavailableSession = undefined;
      const url = new URL(location.href);
      if (current === undefined) url.searchParams.delete('session');
      else url.searchParams.set('session', current);
      if (url.href !== location.href) history.replaceState(null, '', url);
    };
    ctx.effect(() => {
      const unsubscribe = this.sessions.list.subscribe(reconcile);
      reconcile();
      return () => { this.lifetime.abort(); unsubscribe(); };
    });
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    this.lifetime.signal.throwIfAborted();
    const inflight = this.connecting.get(workspaceId);
    if (inflight) return inflight;
    const snapshot = this.ctx.workspaces.list.getSnapshot();
    const workspace = snapshot.items.find(row => row.workspaceId === workspaceId);
    if (!workspace) throw new Error('Selected portable workspace is unavailable');
    const summaries = this.sessions.list.getSnapshot().byId;
    const blank = workspace.sessionIds.find(id => summaries[id]?.blank && !snapshot.archivedSessionIds.includes(id));
    if (blank) return blank;
    const attempt = this.sessions.create({ workspaceId }).finally(() => { this.connecting.delete(workspaceId); });
    this.connecting.set(workspaceId, attempt);
    return attempt;
  }

  openSession(sessionId: SessionId): void {
    this.lifetime.signal.throwIfAborted();
    this.initial = null;
    this.unavailableSession = undefined;
    this.sessions.open(sessionId);
    this.ctx.layout.selectPanel(null);
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    const id = await this.connectWorkspace(workspaceId);
    if (navigation.aborted) return;
    beforeOpen?.(id);
    if (!navigation.aborted) this.openSession(id);
  }

  async registerWorkspace(register: () => Promise<WorkspaceId>): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    navigation.throwIfAborted();
    const workspaceId = await register();
    if (navigation.aborted) return;
    const id = await this.connectWorkspace(workspaceId);
    if (!navigation.aborted) this.openSession(id);
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    const id = await this.sessions.fork({ sessionId, increaseTitle: true });
    if (!navigation.aborted) this.openSession(id);
  }

  startSession(workspaceId?: WorkspaceId): void {
    const current = this.sessions.list.getSnapshot().current;
    const selected = workspaceId ?? this.ctx.workspaces.list.getSnapshot().items.find(row => row.sessionIds.includes(current!))?.workspaceId;
    if (selected === undefined) {
      this.initial = null;
      this.unavailableSession = undefined;
      this.sessions.clear();
      this.ctx.layout.selectPanel(null);
      return;
    }
    void this.openWorkspace(selected).catch(error => console.error(error));
  }

  async archiveSession(id: SessionId): Promise<void> {
    await this.ctx.workspaces.archiveSession(id);
    if (!this.lifetime.signal.aborted && this.sessions.list.getSnapshot().current === id) this.sessions.clear();
  }

  async pickDirectory(): Promise<never> { throw new Error('Choose an explicit World and remote directory'); }
  async listDirectory(): Promise<never> { throw new Error('Directory browsing requires a World'); }
  async createDirectory(): Promise<never> { throw new Error('Create directories through the bound remote workspace'); }
}
