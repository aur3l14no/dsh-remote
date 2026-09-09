import { Service, type Context } from '@deepseek-ai/cordis';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorldView } from '../contracts.ts';
import '../contracts.ts';
import { contribution } from '../wire.ts';

class Navigation extends Service implements UiWorkspace {
  unavailableSession?: string;
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>();
  private get sessions(): ISessions { return this.ctx.get('sessions') as unknown as ISessions; }
  constructor(ctx: Context) {
    super(ctx, 'uiWorkspace');
    let initial = new URL(location.href).searchParams.get('session');
    const reconcile = () => {
      const snapshot = this.sessions.list.getSnapshot();
      if (initial) {
        if (snapshot.phase !== 'ready') return;
        const id = initial as SessionId;
        initial = null;
        if (snapshot.byId[id]) this.sessions.open(id);
        else this.unavailableSession = id;
        return;
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
      return unsubscribe;
    });
  }
  async connectWorkspace(workspaceId: WorkspaceId) {
    const inflight = this.connecting.get(workspaceId);
    if (inflight) return inflight;
    const snapshot = this.ctx.workspaces.list.getSnapshot();
    const workspace = snapshot.items.find(row => row.workspaceId === workspaceId);
    const summaries = this.sessions.list.getSnapshot().byId;
    const blank = workspace?.sessionIds.find(id => summaries[id]?.blank && !snapshot.archivedSessionIds.includes(id));
    if (blank) return blank;
    const attempt = this.sessions.create({ workspaceId }).finally(() => { this.connecting.delete(workspaceId); });
    this.connecting.set(workspaceId, attempt);
    return attempt;
  }
  startSession(workspaceId?: WorkspaceId) {
    const current = this.sessions.list.getSnapshot().current;
    const selected = workspaceId ?? this.ctx.workspaces.list.getSnapshot().items.find(row => row.sessionIds.includes(current!))?.workspaceId;
    if (selected === undefined) { this.sessions.clear(); return; }
    void this.connectWorkspace(selected).then(id => this.sessions.open(id), error => console.error(error));
  }
  async archiveSession(id: SessionId) {
    await this.ctx.workspaces.archiveSession(id);
    if (this.sessions.list.getSnapshot().current === id) this.sessions.clear();
  }
  async pickDirectory(): Promise<never> { throw new Error('Choose an explicit World and remote directory'); }
  async listDirectory(): Promise<never> { throw new Error('Directory browsing requires a World'); }
  async createDirectory(): Promise<never> { throw new Error('Create directories through the bound remote workspace'); }
}

export const inject = ['slots', 'sessions', 'workspaces', 'remote'];
export async function apply(ctx: Context) {
  await ctx.plugin({ inject: ['remote'], async apply(ctx: Context) {
    await ctx.remote.$mount({ package: contribution.package, descriptors: contribution.invocations });
  } });
  await ctx.plugin({ inject: [...inject, 'remote.portableWorkspace'], apply: installWorkspaceUi });
}

function installWorkspaceUi(ctx: Context) {
  const navigation = new Navigation(ctx);
  const sessionController = ctx.get('sessions') as unknown as ISessions;
  ctx.slots.provideRoot({ hooks: { workspaces: ctx.workspaces.list } });
  const workspaceSource = ctx.workspaces.list;
  const subscribeWorkspaces = (listener: () => void) => workspaceSource.subscribe(listener);
  const workspaceSnapshot = () => workspaceSource.getSnapshot();
  const subscribeSessions = (listener: () => void) => sessionController.list.subscribe(listener);
  const sessionSnapshot = () => sessionController.list.getSnapshot();
  function Workspaces() {
    const snapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot);
    const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot);
    const [host, setHost] = useState('');
    const [hosts, setHosts] = useState<string[]>([]);
    const [directories, setDirectories] = useState<string[]>([]);
    const [status, setStatus] = useState('');
    const [worlds, setWorlds] = useState<WorldView[]>([]);
    const [world, setWorld] = useState('');
    const [path, setPath] = useState('');
    const [error, setError] = useState('');
    const [syncStatus, setSyncStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [renaming, setRenaming] = useState<WorkspaceId>();
    const [title, setTitle] = useState('');
    useEffect(() => {
      let active = true;
      void ctx.remote.portableWorkspace.hosts().then(result => { if (active && result.ok) setHosts(result.value); }).catch(() => {});
      void ctx.remote.portableWorkspace.worlds().then(result => {
        if (!active) return;
        if (!result.ok) { setError(result.error.message); return; }
        setWorlds(result.value);
      });
      return () => { active = false; };
    }, []);
    async function browse(next: string, selected = world) {
      setPath(next); setDirectories([]);
      const result = await ctx.remote.portableWorkspace.directories({ worldId: selected, path: next });
      if (!result.ok) throw new Error(result.error.message);
      setDirectories(result.value);
    }
    async function perform(action: () => Promise<void>) {
      setBusy(true); setError('');
      try { await action(); } catch (error) { setError(String(error)); }
      finally { setBusy(false); setStatus(''); }
    }
    return <section className="portable-workspaces" aria-label="Portable workspaces">
      <style>{`
        .portable-workspaces { padding: 12px; display: grid; gap: 12px; font-size: 13px; }
        .portable-workspaces h3 { margin: 0 0 4px; font-size: 14px; }
        .portable-workspaces label { display: grid; gap: 5px; }
        .portable-workspaces input, .portable-workspaces select, .portable-workspaces button {
          box-sizing: border-box; width: 100%; min-width: 0; padding: 7px 9px;
          font: inherit; color: inherit; background: transparent;
          border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 7px;
        }
        .portable-workspaces button { cursor: pointer; text-align: left; overflow-wrap: anywhere; }
        .portable-workspaces button:hover, .portable-workspaces button[aria-current] {
          background: color-mix(in srgb, currentColor 7%, transparent);
        }
        .portable-workspaces button:disabled { cursor: default; opacity: .5; }
        .portable-workspaces > section { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
        .portable-workspaces > section > div { opacity: .7; overflow-wrap: anywhere; }
        .portable-workspaces summary { cursor: pointer; padding: 5px 0; }
        .portable-workspaces .workspace-actions, .portable-workspaces form, .portable-workspaces .workspace-session { display: grid; gap: 5px; }
        .portable-workspaces [role=alert] { margin: 0; color: #ba3232; overflow-wrap: anywhere; }
      `}</style>
      <h3>Remote workspaces</h3>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        setStatus(`Connecting to ${host} and preparing the remote environment…`);
        const result = await ctx.remote.portableWorkspace.connect({ host });
        if (!result.ok) throw new Error(result.error.message);
        setWorlds(previous => [...previous.filter(item => item.id !== result.value.world.id), result.value.world]);
        setWorld(result.value.world.id);
        await browse(result.value.home, result.value.world.id);
      }); }}>
        <label>SSH host<input aria-label="SSH host" list="ssh-hosts" placeholder="user@host or SSH alias" value={host} onChange={event => setHost(event.target.value)} /></label>
        <datalist id="ssh-hosts">{hosts.map(value => <option key={value} value={value} />)}</datalist>
        <button type="submit" disabled={busy || !host.trim()}>Connect to Host</button>
      </form>
      {status && <p role="status">{status}</p>}
      {worlds.length > 0 && <>
      <label>World<select aria-label="World" value={world} onChange={event => { setWorld(event.target.value); setDirectories([]); }}>
        <option value="">Choose a World</option>
        {worlds.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button disabled={!world || busy} onClick={() => { void perform(async () => {
        setSyncStatus('');
        const result = await ctx.remote.portableWorkspace.syncSkills({ worldId: world });
        if (!result.ok) throw new Error(result.error.message);
        setSyncStatus(`Synced ${result.value.count} skills to ${worlds.find(item => item.id === world)?.name ?? world}`);
      }); }}>Sync Skills</button>
      {syncStatus && <p role="status">{syncStatus}</p>}
      <label>Remote directory<input aria-label="Remote directory" placeholder="/path/to/repository" value={path} onChange={event => setPath(event.target.value)} /></label>
      {world && <details><summary>Browse folders</summary>
        <button disabled={busy || !path.startsWith('/')} onClick={() => { void perform(() => browse(path)); }}>Browse</button>
        <button disabled={busy || path === '/'} onClick={() => { void perform(() => browse(path.slice(0, path.replace(/\/$/, '').lastIndexOf('/')) || '/')); }}>Parent folder</button>
        {directories.map(name => <button key={name} disabled={busy} onClick={() => { void perform(() => browse(path.replace(/\/$/, '') + '/' + name)); }}>{name}/</button>)}
      </details>}
      <button disabled={!world || !path.startsWith('/') || busy} onClick={() => { void perform(async () => {
        const result = await ctx.remote.portableWorkspace.create({ worldId: world, path });
        if (!result.ok) throw new Error(result.error.message);
        const id = await navigation.connectWorkspace(result.value.workspaceId);
        sessionController.open(id);
      }); }}>Open Folder</button>
      </>}
      {navigation.unavailableSession && <p role="alert">The linked Session is unavailable.</p>}
      {error && <p role="alert">{error}</p>}
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      {snapshot.items.map((row, rowIndex) => <section key={row.workspaceId} aria-label={row.title}>
        <strong>{row.title}</strong><div>{row.path}</div>
        <details>
          <summary>Manage {row.title}</summary>
          <div className="workspace-actions">
            <button disabled={busy} onClick={() => { setRenaming(row.workspaceId); setTitle(row.title); }}>Rename {row.title}</button>
            <button disabled={busy || rowIndex === 0} onClick={() => { void perform(() => ctx.workspaces.insertBefore(row.workspaceId, snapshot.items[rowIndex - 1]!.workspaceId)); }}>Move {row.title} up</button>
            <button disabled={busy || rowIndex === snapshot.items.length - 1} onClick={() => { void perform(() => ctx.workspaces.insertBefore(row.workspaceId, snapshot.items[rowIndex + 2]?.workspaceId)); }}>Move {row.title} down</button>
            <button disabled={busy} onClick={() => { void perform(async () => {
              await ctx.workspaces.delete(row.workspaceId);
              if (row.sessionIds.includes(sessions.current!)) sessionController.clear();
            }); }}>Remove {row.title} from list</button>
            <small>Removing a registration keeps remote files and conversation history. Add the same World and directory to restore it.</small>
          </div>
        </details>
        {renaming === row.workspaceId && <form onSubmit={event => { event.preventDefault(); void perform(async () => {
          await ctx.workspaces.rename(row.workspaceId, title); setRenaming(undefined);
        }); }}>
          <label>Workspace title<input aria-label="Workspace title" value={title} onChange={event => setTitle(event.target.value)} /></label>
          <button disabled={busy || !title.trim()} type="submit">Save title</button>
          <button type="button" onClick={() => setRenaming(undefined)}>Cancel rename</button>
        </form>}
        <button disabled={busy} onClick={() => { void perform(async () => {
          sessionController.open(await navigation.connectWorkspace(row.workspaceId));
        }); }}>New session in {row.title}</button>
        {row.sessionIds.filter(id => !snapshot.archivedSessionIds.includes(id)).map((id, index, visible) => <div className="workspace-session" key={id}>
          <button disabled={busy} aria-label={`Open session ${id}`} aria-current={sessions.current === id ? 'page' : undefined} onClick={() => sessionController.open(id)}>
            {sessions.byId[id]?.title || id}
          </button>
          <details><summary aria-label={`Manage session ${id}`}>Session actions</summary>
            <button disabled={busy} onClick={() => { void perform(() => navigation.archiveSession(id)); }}>Archive session {id}</button>
            <button disabled={busy || index === 0} onClick={() => { void perform(async () => { await ctx.workspaces.insertSessionBefore(row.workspaceId, id, visible[index - 1]); }); }}>Move session {id} up</button>
          </details>
        </div>)}
      </section>)}
    </section>;
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces' }, Workspaces));
  // The sidebar owns selection. Keep the conversation's native composer and Session UI untouched.
}
