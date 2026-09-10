import type { Context } from '@deepseek-ai/cordis';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { Navigation } from './navigation.ts';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorldView } from '../contracts.ts';
import '../contracts.ts';
import { contribution } from '../wire.ts';


export const inject = ['slots', 'sessions', 'workspaces', 'remote', 'layout'];
export async function apply(ctx: Context) {
  await ctx.plugin({ inject: ['remote'], async apply(ctx: Context) {
    await ctx.remote.$mount({ package: contribution.package, descriptors: contribution.invocations });
  } });
  await ctx.plugin({ inject: [...inject, 'remote.portableWorkspace'], apply: installWorkspaceUi });
}

function WorldLogo({ color }: { color: string }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>;
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
    const [connectionOpen, setConnectionOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
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
    const [color, setColor] = useState('#60a5fa');
    const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
    const selectedWorld = worlds.find(item => item.id === world);
    useEffect(() => {
      setColor(selectedWorld?.color ?? '#60a5fa');
      setEnabledSkills(selectedWorld?.skills.filter(skill => skill.enabled).map(skill => skill.name) ?? []);
    }, [selectedWorld]);
    useEffect(() => {
      let active = true;
      void ctx.remote.portableWorkspace.worlds().then(result => {
        if (active) { if (result.ok) setWorlds(result.value); else setError(result.error.message); }
      }).catch(error => { if (active) setError(String(error)); });
      return () => { active = false; };
    }, [snapshot.items]);
    useEffect(() => {
      let active = true;
      void ctx.remote.portableWorkspace.hosts().then(result => { if (active && result.ok) setHosts(result.value); }).catch(() => {});
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
        .portable-workspaces { position: relative; padding: 4px 8px 12px; display: grid; gap: 4px; font-size: 13px; }
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
        .portable-workspaces .workspace-management { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
        .portable-workspaces .workspace-path { opacity: .65; overflow-wrap: anywhere; }
        .portable-workspaces .session-card { min-height: 84px; padding: 9px 12px; display: grid; gap: 4px; text-align: left; border-color: transparent; border-radius: 10px; }
        .portable-workspaces .session-card[aria-current] { border-color: transparent; background: color-mix(in srgb, var(--world-color) 10%, transparent); }
        .portable-workspaces .session-context { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12px; opacity: .7; padding-right: 20px; }
        .portable-workspaces .session-context svg { flex: none; }
        .portable-workspaces .session-title { font-size: 15px; line-height: 1.4; font-weight: 500; overflow-wrap: anywhere; }
        .portable-workspaces .session-path { font-size: 11px; opacity: .6; overflow-wrap: anywhere; }
        .portable-workspaces .skill-option { display: flex; align-items: center; gap: 8px; }
        .portable-workspaces .skill-option input { width: auto; }
        .portable-workspaces .world-settings { display: grid; gap: 10px; padding: 8px 0; }
        .portable-workspaces input[type=color] { height: 36px; }
        .portable-workspaces .session-toolbar { padding: 6px 12px; font-size: 11px; font-weight: 600; letter-spacing: .06em; opacity: .55; }
        .portable-workspaces .sidebar-manager { padding: 0 8px; }
        .portable-workspaces .sidebar-manager > summary { position: absolute; top: 4px; right: 16px; list-style: none; font-size: 21px; line-height: 24px; padding: 0 5px; opacity: .6; }
        .portable-workspaces summary::-webkit-details-marker { display: none; }
        .portable-workspaces .sidebar-manager[open] { padding-bottom: 16px; display: grid; gap: 12px; }
        .portable-workspaces .session-list { display: grid; gap: 2px; }
        .portable-workspaces .workspace-session { position: relative; }
        .portable-workspaces .session-menu { position: absolute; right: 8px; top: 8px; z-index: 1; }
        .portable-workspaces .session-menu[open] { z-index: 2; }
        .portable-workspaces .session-menu > summary { list-style: none; padding: 0 5px; font-size: 18px; line-height: 24px; opacity: 0; border-radius: 5px; }
        .portable-workspaces .workspace-session:hover .session-menu > summary,
        .portable-workspaces .workspace-session:focus-within .session-menu > summary,
        .portable-workspaces .session-menu[open] > summary { opacity: .65; }
        .portable-workspaces .session-menu-items { position: absolute; right: 0; top: 28px; width: 210px; padding: 6px; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 10px; background: Canvas; color: CanvasText; box-shadow: 0 6px 24px #0002; display: grid; gap: 4px; }
        .portable-workspaces .session-menu-items button { border: 0; font-size: 12px; }
        @media (hover: none) { .portable-workspaces .session-menu > summary { opacity: .65; } }
        .portable-workspaces summary { cursor: pointer; padding: 5px 0; }
        .portable-workspaces .workspace-actions, .portable-workspaces form, .portable-workspaces .workspace-session { display: grid; gap: 5px; }
        .portable-workspaces [role=alert] { margin: 0; color: #ba3232; overflow-wrap: anywhere; }
      `}</style>
      <div className="session-toolbar"><span>Sessions</span></div>
      <details className="sidebar-manager" open={connectionOpen} onToggle={event => setConnectionOpen(event.currentTarget.open)}><summary aria-label="Connect or open a workspace" title="Workspaces and World settings">＋</summary>
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
      {selectedWorld && <details open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>World settings</summary>
        <form className="world-settings" onSubmit={event => { event.preventDefault(); void perform(async () => {
          const result = await ctx.remote.portableWorkspace.configureWorld({ worldId: world, color, enabledSkills });
          if (!result.ok) throw new Error(result.error.message);
          setWorlds(result.value);
          setSyncStatus('World settings saved. Use Sync Skills to deploy the selection.');
        }); }}>
          <label>World color<input aria-label="World color" type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
          <strong>Skills to sync</strong>
          {selectedWorld.skills.map(skill => <label className="skill-option" key={skill.name}>
            <input type="checkbox" checked={enabledSkills.includes(skill.name)} onChange={event => setEnabledSkills(previous => event.target.checked ? [...previous, skill.name] : previous.filter(name => name !== skill.name))} />{skill.name}
          </label>)}
          {!selectedWorld.skills.length && <small>Add skill source folders to this World's plugin config to make them available here.</small>}
          <small>Selection is shared by Worlds using the same SSH target. Unchecking stops future syncs; installed copies remain.</small>
          <button type="submit" disabled={busy}>Save World settings</button>
        </form>
      </details>}
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
        await navigation.registerWorkspace(async () => {
          const result = await ctx.remote.portableWorkspace.create({ worldId: world, path });
          if (!result.ok) throw new Error(result.error.message);
          return result.value.workspaceId;
        });
      }); }}>Open Folder</button>
      </>}
      {snapshot.items.map((row, rowIndex) => {
        const rowWorld = worlds.find(item => item.workspaceIds.includes(row.workspaceId));
        return <section className="workspace-management" key={row.workspaceId} aria-label={row.title}>
        <strong>{row.title}</strong><div className="workspace-path">{row.path}</div>
        <button disabled={busy || !rowWorld} onClick={() => {
          if (!rowWorld) return;
          setWorld(rowWorld.id);
          setConnectionOpen(true);
          setSettingsOpen(true);
        }}>World settings · {rowWorld?.name ?? 'Unavailable World'}</button>
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
          await navigation.openWorkspace(row.workspaceId);
        }); }}>New session in {row.title}</button>
      </section>; })}
      </details>
      {navigation.unavailableSession && <p role="alert">The linked Session is unavailable.</p>}
      {error && <p role="alert">{error}</p>}
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      <div className="session-list">
      {snapshot.items.flatMap(row => {
        const rowWorld = worlds.find(item => item.workspaceIds.includes(row.workspaceId));
        return row.sessionIds.filter(id => !snapshot.archivedSessionIds.includes(id)).map((id, index, visible) => <div className="workspace-session" key={id}>
          <button className="session-card" style={{ '--world-color': rowWorld?.color ?? '#94a3b8' } as React.CSSProperties} disabled={busy} aria-label={`Open session ${id}`} aria-current={sessions.current === id ? 'page' : undefined} onClick={() => navigation.openSession(id)}>
            <span className="session-context"><WorldLogo color={rowWorld?.color ?? '#94a3b8'} /><span>{rowWorld?.name ?? 'Unavailable World'} · {rowWorld && row.title.startsWith(rowWorld.name + ' · ') ? row.title.slice(rowWorld.name.length + 3) : row.title}</span></span>
            <span className="session-title">{sessions.byId[id]?.title || 'New session'}</span>
            <span className="session-path" title={row.path}>⌂ {row.path}</span>
          </button>
          <details className="session-menu"><summary aria-label={`Manage session ${id}`} title="Session actions">···</summary><div className="session-menu-items">
            <button aria-label={`Archive session ${id}`} disabled={busy} onClick={() => { void perform(() => navigation.archiveSession(id)); }}>Archive session</button>
            <button disabled={busy || index === 0} onClick={() => { void perform(async () => { await ctx.workspaces.insertSessionBefore(row.workspaceId, id, visible[index - 1]); }); }}>Move up</button>
          </div></details>
        </div>);
      })}
      </div>
    </section>;
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces' }, Workspaces));
  // The sidebar owns selection. Keep the conversation's native composer and Session UI untouched.
}
