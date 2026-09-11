import type { Context } from '@deepseek-ai/cordis';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Menu, Modal, Button, Tooltip, IconFolderClose16, IconArchiveOutline20, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import { ReloadWorlds } from './reload.tsx';
import { Navigation } from './navigation.ts';
import { observe } from '../../../../../shared/lifetime.ts';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WorldView } from '../contracts.ts';
import '../contracts.ts';
import { contribution } from '../wire.ts';

export const inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.directoryPicker', 'layout'];
export async function apply(ctx: Context) {
  await ctx.plugin({ inject: ['remote'], async apply(ctx: Context) {
    await ctx.remote.$mount({ package: contribution.package, descriptors: contribution.invocations });
  } });
  await ctx.plugin({ inject: [...inject, 'remote.portableWorkspace'], apply: installWorkspaceUi });
}

function WorldLogo({ color }: { color: string }) {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>;
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m16 3 5 5-4 1-3 5v3l-7-7h3l5-3zM7 17l-4 4" />
  </svg>;
}

function installWorkspaceUi(ctx: Context) {
  const navigation = new Navigation(ctx, ctx.remote.directoryPicker);
  const sessionController = ctx.get('sessions') as unknown as ISessions;
  ctx.slots.provideRoot({ hooks: { workspaces: ctx.workspaces.list } });
  const workspaceSource = ctx.workspaces.list;
  const subscribeWorkspaces = (listener: () => void) => workspaceSource.subscribe(listener);
  const workspaceSnapshot = () => workspaceSource.getSnapshot();
  const subscribeSessions = (listener: () => void) => sessionController.list.subscribe(listener);
  const sessionSnapshot = () => sessionController.list.getSnapshot();

  function useWorlds() {
    const [worlds, setWorlds] = useState<WorldView[]>([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      let active = true;
      setLoading(true); setError('');
      const stream = ctx.remote.$stream<WorldView[]>({ name: 'World presentation',
        open: signal => ctx.remote.portableWorkspace.followWorlds(signal),
        ended: () => new RemoteStreamCarrierError('World presentation stream ended'),
        carrierFailed: error => { if (active) setError(error.message); },
      });
      void (async () => {
        for await (const item of stream) {
          if (!active) break;
          setWorlds(item.value); setError(''); setLoading(false); item.accept();
        }
      })().catch(error => { if (active) { setError(String(error)); setLoading(false); } });
      return () => { active = false; void stream.dispose(); };
    }, []);
    return { worlds, error, loading };
  }

  function WorkspacePicker({ open, anchorRef, selectedId, onPick, onClose, renderSlot }: PropsRuntime<'conversation.hero.workspace'> & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>) {
    const snapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot);
    const { worlds, error: catalogError, loading } = useWorlds();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const attempt = useRef<AbortController | null>(null);
    const localAttempt = useRef<{ controller: AbortController; signal: AbortSignal } | null>(null);
    const [flowOpen, setFlowOpen] = useState(false);
    const [flowError, setFlowError] = useState('');
    const flowAvailable = useSyncExternalStore(
      useCallback(listener => ctx.slots.subscribe('conversation.hero.workspace.directoryFlow', listener), []),
      () => ctx.slots.entries('conversation.hero.workspace.directoryFlow').length > 0,
    );
    useEffect(() => () => { localAttempt.current?.controller.abort(); }, []);
    useEffect(() => { if (!flowAvailable) { localAttempt.current?.controller.abort(); setFlowOpen(false); } }, [flowAvailable]);
    const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef]);
    useEffect(() => {
      setError(''); setBusy(false);
      return () => { attempt.current?.abort(); };
    }, [open]);
    const options = worlds.flatMap(world => world.workspaces.map(workspace => ({ world, workspace,
      key: JSON.stringify([world.id, workspace.path]),
    })));
    const items: MenuEntry[] = worlds.filter(world => world.workspaces.length || (world.kind === 'local' && flowAvailable)).flatMap((world, index) => [
      ...(index ? [{ type: 'separator' as const, id: `separator:${world.id}` }] : []),
      { type: 'label' as const, id: `world:${world.id}`, text: world.name },
      ...(world.kind === 'local' && flowAvailable ? [{ id: 'local:browse', disabled: busy || flowOpen, label: 'Choose a folder…', icon: <IconFolderClose16 size={16} /> }] : []),
      ...options.filter(option => option.world.id === world.id).map(({ workspace, key }) => ({
        id: key, disabled: busy || loading,
        icon: <span style={{ color: world.color }}><IconFolderClose16 size={16} /></span>,
        label: <span className="workspace-option" title={`${world.name} · ${workspace.path}`} style={{ display: 'grid', gap: 1, minWidth: 0 }}>
          <span className="workspace-option-name">{workspace.name ?? (workspace.path.split('/').filter(Boolean).at(-1) || '/')}</span>
          <small className="workspace-option-path" title={workspace.path}>{workspace.path}</small>
        </span>,
      })),
    ]);
    if (loading) items.unshift({ type: 'label', id: 'loading', text: 'Loading workspaces…' });
    if (!loading && !options.length) items.push({ type: 'label', id: 'empty', text: 'Add workspaces to $DSH_HOME/remote/worlds.json, then use Reload worlds.' });
    if (busy) items.unshift({ type: 'label', id: 'busy', text: 'Connecting to workspace…' });
    if (error || catalogError) items.unshift({ id: 'error', disabled: true, label: <span role="alert">{error || catalogError}</span> });
    const selected = options.find(({ world, workspace }) => world.workspaceIds.includes(selectedId!)
      && snapshot.items.some(row => row.workspaceId === selectedId && row.path === workspace.path));
    async function select(key: string) {
      if (attempt.current && !attempt.current.signal.aborted) return;
      if (key === 'local:browse') {
        localAttempt.current?.controller.abort();
        const controller = new AbortController();
        localAttempt.current = { controller, signal: AbortSignal.any([controller.signal, ctx.layout.beginNavigation(), AbortSignal.timeout(120000)]) };
        setFlowError(''); setFlowOpen(true); onClose(); return;
      }
      const option = options.find(option => option.key === key);
      if (!option) return;
      const controller = new AbortController();
      attempt.current = controller;
      const signal = AbortSignal.any([controller.signal, ctx.layout.beginNavigation(), AbortSignal.timeout(120000)]);
      setBusy(true); setError('');
      try {
        const result = await observe(ctx.remote.portableWorkspace.create({ worldId: option.world.id, path: option.workspace.path }), signal);
        if (!result.ok) throw new Error(result.error.message);
        // The create response can precede the external workspace feed frame.
        await navigation.waitForWorkspace(result.value.workspaceId, signal);
        signal.throwIfAborted();
        onPick(result.value.workspaceId);
      } catch (error) {
        if (!controller.signal.aborted && !signal.aborted) setError(String(error));
        else if (!controller.signal.aborted && signal.reason?.name === 'TimeoutError') setError('Connection timed out. Try again.');
      } finally {
        controller.abort();
        if (attempt.current === controller) { attempt.current = null; setBusy(false); }
      }
    }
    async function pickedLocal(path: string) {
      const pending = localAttempt.current;
      if (!pending || pending.signal.aborted) { setFlowOpen(false); return; }
      setBusy(true);
      try {
        const result = await observe(ctx.remote.portableWorkspace.create({ worldId: 'local', path }), pending.signal);
        if (!result.ok) throw new Error(result.error.message);
        await navigation.waitForWorkspace(result.value.workspaceId, pending.signal);
        pending.signal.throwIfAborted();
        onPick(result.value.workspaceId);
      } catch (error) {
        if (!pending.signal.aborted) setFlowError(String(error));
      } finally {
        pending.controller.abort();
        if (localAttempt.current === pending) { localAttempt.current = null; setFlowOpen(false); setBusy(false); }
      }
    }
    return <><style>{`
      [role=menu]:has(.workspace-option) { width: min(320px, calc(100vw - 24px)); min-width: 0; max-width: 320px; padding: 6px; border-radius: 12px; }
      [role=menu]:has(.workspace-option) [role=presentation] > [role=presentation] { padding: 5px 10px; font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      [role=menu]:has(.workspace-option) [role=menuitem] { padding: 7px 10px; min-height: 44px; align-items: flex-start; gap: 10px; border-radius: 7px; }
      [role=menu]:has(.workspace-option) [role=menuitem]:has(.workspace-option) > span:first-child { margin-top: 2px; }
      .workspace-option-name { font-size: 13px; font-weight: 500; line-height: 19px; overflow: hidden; text-overflow: ellipsis; }
      .workspace-option-path { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #858990); overflow: hidden; text-overflow: ellipsis; }
    `}</style><Menu open={open} anchor={null} items={items} selectedId={selected?.key}
      onSelect={key => { void select(key); }} onClose={onClose} getAnchorRect={getAnchorRect} portal autoFocus />
      {renderSlot('conversation.hero.workspace.directoryFlow', { open: flowOpen, busy,
        onPicked: path => { void pickedLocal(path); },
        onCancel: () => { localAttempt.current?.controller.abort(); setFlowOpen(false); },
        onError: message => { localAttempt.current?.controller.abort(); setFlowOpen(false); setFlowError(message); },
      })}
      <Modal open={Boolean(flowError)} onClose={() => setFlowError('')} title="Unable to open workspace" closeLabel="Close"
        footer={<Button onClick={() => setFlowError('')}>Close</Button>}><p role="alert">{flowError}</p></Modal>
    </>;
  }

  function Workspaces({ renderSlot }: PropsRenderSlots<'sidebar.workspaces.directoryFlow'>) {
    const snapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot);
    const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot);
    const { worlds, error: catalogError } = useWorlds();
    const pinned = worlds.flatMap(world => world.pinnedSessionIds);
    const [busySession, setBusySession] = useState<string>();
    const [error, setError] = useState('');
    async function perform(action: () => Promise<void>) {
      setError('');
      try { await action(); } catch (error) { setError(String(error)); }
    }
    return <section className="portable-workspaces" aria-label="Portable workspaces">
      <style>{`
        .portable-workspaces { padding: 0; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; gap: 4px; font-size: 13px; min-width: 0; }
        .portable-workspaces button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; }
        .portable-workspaces button:focus-visible, .portable-workspaces summary:focus-visible { outline: 2px solid #60a5fa; outline-offset: -2px; }
        .portable-workspaces .session-list { display: grid; align-content: start; flex: 1; min-height: 0; gap: 3px; min-width: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 6px; }
        .portable-workspaces .workspace-session { position: relative; min-width: 0; }
        .portable-workspaces .session-card { width: 100%; min-width: 0; padding: 7px 6px; display: grid; gap: 3px; text-align: left; border-radius: 8px; }
        .portable-workspaces button:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
        .portable-workspaces .session-card[aria-current] { background: color-mix(in srgb, currentColor 7%, transparent); }
        .portable-workspaces .session-context { display: flex; align-items: center; gap: 6px; min-width: 0; padding-right: 48px; font-size: 11px; line-height: 16px; color: color-mix(in srgb, currentColor 55%, transparent); }
        .portable-workspaces .session-context svg, .portable-workspaces .session-path svg { flex: none; }
        .portable-workspaces .session-context span, .portable-workspaces .session-title, .portable-workspaces .session-path span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .portable-workspaces .session-title { font-size: 13px; line-height: 19px; font-weight: 500; letter-spacing: -.01em; }
        .portable-workspaces .session-path { display: flex; gap: 6px; align-items: center; min-width: 0; font-size: 11px; line-height: 16px; opacity: .45; }
        .portable-workspaces .session-actions { position: absolute; right: 7px; top: 5px; display: flex; gap: 2px; }
        .portable-workspaces .session-actions button { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 5px; padding: 0; opacity: 0; pointer-events: none; }
        .portable-workspaces .session-actions button[aria-pressed=true] { opacity: .5; pointer-events: auto; }
        .portable-workspaces .workspace-session:hover .session-actions button,
        .portable-workspaces .workspace-session:focus-within .session-actions button { opacity: .65; pointer-events: auto; }
        .portable-workspaces .session-actions button:hover, .portable-workspaces .session-actions button:focus-visible { opacity: 1; }
        .portable-workspaces .session-actions button:disabled { opacity: .25; cursor: wait; }
        .portable-workspaces .empty-sessions { margin: 4px 6px; opacity: .5; font-size: 12px; line-height: 1.6; }
        .portable-workspaces [role=alert] { margin: 4px 6px; color: #ba3232; overflow-wrap: anywhere; }
        @media (hover: none) { .portable-workspaces .session-actions button { opacity: .65; pointer-events: auto; } }
      `}</style>
      <ReloadWorlds ctx={ctx} />
      {navigation.unavailableSession && <p role="alert">The linked Session is unavailable.</p>}
      {(error || catalogError || snapshot.error) && <p role="alert">{error || catalogError || snapshot.error?.message}</p>}
      {!snapshot.items.some(row => row.sessionIds.some(id => !snapshot.archivedSessionIds.includes(id))) && <p className="empty-sessions">Start a new session to choose a workspace.</p>}
      <div className="session-list">
      {snapshot.items.flatMap(row => row.sessionIds.filter(id => !snapshot.archivedSessionIds.includes(id)).map(id => ({ row, id })))
        .sort((a, b) => {
          const left = pinned.indexOf(a.id), right = pinned.indexOf(b.id);
          return left < 0 ? (right < 0 ? 0 : 1) : right < 0 ? -1 : left - right;
        }).map(({ row, id }) => {
        const rowWorld = worlds.find(item => item.workspaceIds.includes(row.workspaceId));
        const name = rowWorld && row.title.startsWith(rowWorld.name + ' · ') ? row.title.slice(rowWorld.name.length + 3) : row.title;
        const title = sessions.byId[id]?.title || 'New session';
        const isPinned = pinned.includes(id);
        return <div className="workspace-session" key={id}>
          <Tooltip label={`${title}\n${rowWorld?.name ?? 'Unavailable World'} / ${name}\n${row.path}`} side="right" delayMs={650} maxWidth={360}>
          <button className="session-card" aria-label={`Open session ${id}`} aria-current={sessions.current === id ? 'page' : undefined} onClick={() => navigation.openSession(id)}>
            <span className="session-context"><WorldLogo color={rowWorld?.color ?? '#94a3b8'} /><span>{rowWorld?.name ?? 'Unavailable World'} / {name}</span></span>
            <span className="session-title">{title}</span>
            <span className="session-path"><IconFolderClose16 size={12} /><span>{row.path}</span></span>
          </button>
          </Tooltip>
          <div className="session-actions">
            <button aria-label={`${isPinned ? 'Unpin' : 'Pin'} session ${id}`} title={isPinned ? 'Unpin session' : 'Pin session'} aria-pressed={isPinned} disabled={busySession !== undefined} onClick={() => {
              setBusySession(id);
              void perform(async () => {
                try {
                  const result = await ctx.remote.portableWorkspace.pinSession({ sessionId: id, pinned: !isPinned });
                  if (!result.ok) throw new Error(result.error.message);
                } finally { setBusySession(undefined); }
              });
            }}><PinIcon pinned={isPinned} /></button>
            <button aria-label={`Archive session ${id}`} title="Archive session" disabled={busySession !== undefined} onClick={() => {
              setBusySession(id);
              void perform(async () => { try { await navigation.archiveSession(id); } finally { setBusySession(undefined); } });
            }}><IconArchiveOutline20 size={16} /></button>
          </div>
        </div>;
      })}
      </div>
      {renderSlot('sidebar.workspaces.directoryFlow', { open: false, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} })}
    </section>;
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces', children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } } }, Workspaces));
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({ name: 'conversation.hero.workspace', children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } } }, WorkspacePicker));
}
