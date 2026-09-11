import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type { ReloadPreview, ReloadResult, ReloadStatus } from '../contracts.ts';

export function ReloadWorlds({ ctx, onReload }: { ctx: Context; onReload: (generation: number) => void }) {
  const [status, setStatus] = useState<ReloadStatus>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ReloadPreview>();
  const [result, setResult] = useState<ReloadResult>();
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const attempt = useRef(0);
  const planId = useRef<string>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await ctx.remote.portableWorkspace.reloadStatus();
        if (active && response.ok) { setStatus(response.value); onReload(response.value.generation); }
      } catch { /* Gateway reconnection retries on the next poll. */ }
      finally { if (active) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [ctx, onReload]);
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  useEffect(() => () => {
    attempt.current++;
    if (planId.current) void ctx.remote.portableWorkspace.cancelReload({ id: planId.current }).catch(() => {});
  }, [ctx]);
  async function inspect() {
    const current = ++attempt.current;
    setOpen(true); setBusy(true); setError(''); setPreview(undefined); setResult(undefined);
    try {
      const response = await ctx.remote.portableWorkspace.previewReload();
      if (!response.ok) throw new Error(response.error.message);
      if (attempt.current !== current) { void ctx.remote.portableWorkspace.cancelReload({ id: response.value.id }).catch(() => {}); return; }
      planId.current = response.value.id; setPreview(response.value);
    } catch (error) { if (current === attempt.current) setError(String(error)); }
    finally { if (current === attempt.current) setBusy(false); }
  }
  function close() {
    if (busy && preview) return;
    attempt.current++;
    if (planId.current) void ctx.remote.portableWorkspace.cancelReload({ id: planId.current }).catch(() => {});
    planId.current = undefined; setBusy(false); setOpen(false);
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const response = await ctx.remote.portableWorkspace.applyReload({ id: preview.id });
      if (!response.ok) throw new Error(response.error.message);
      setResult(response.value); setPreview(undefined); planId.current = undefined;
      const latest = await ctx.remote.portableWorkspace.reloadStatus();
      if (latest.ok) { setStatus(latest.value); onReload(latest.value.generation); }
    } catch (error) { setError(String(error)); setPreview(undefined); }
    finally { setBusy(false); }
  }
  return <>
    <style>{`
      .worlds-reload-footer { display: flex; }
      .workspace-toolbar .worlds-reload-entry { display: inline-flex; align-items: center; justify-content: center; gap: 7px; position: relative; width: 28px; height: 28px; padding: 0; border-radius: 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #858990); }
      .workspace-toolbar .worlds-reload-entry[data-changed=true] { color: var(--dsw-alias-label-secondary, #686b73); }
      .worlds-reload-entry svg { flex: none; }
      .worlds-reload-dot { position: absolute; right: 3px; top: 3px; width: 5px; height: 5px; border-radius: 50%; background: #c18b3e; }
      .workspace-toolbar .worlds-reload-entry:disabled { opacity: .4; cursor: wait; }
      .worlds-reload-dialog { color-scheme: light dark; color: CanvasText; background: Canvas; border: 1px solid #8885; border-radius: 12px; padding: 24px; width: min(720px, calc(100vw - 48px)); max-height: 80vh; box-sizing: border-box; font: 13px/1.5 system-ui; }
      .worlds-reload-dialog::backdrop { background: #0006; }
      .worlds-reload-dialog h2 { font-size: 19px; margin: 0 0 10px; }
      .worlds-reload-dialog h3 { font-size: 14px; margin: 18px 0 8px; }
      .worlds-reload-dialog p { margin: 8px 0; }
      .worlds-reload-dialog .reload-note { opacity: .65; }
      .worlds-reload-dialog pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
      .worlds-reload-dialog details { border-top: 1px solid #8883; padding: 8px 0; }
      .worlds-reload-dialog summary { cursor: pointer; }
      .worlds-reload-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
      .worlds-reload-dialog footer button { border: 1px solid #8885; border-radius: 6px; padding: 7px 12px; }
      .worlds-reload-dialog footer button:disabled { opacity: .45; cursor: default; }
      .worlds-reload-dialog footer .reload-apply { background: #2563eb; color: white; border-color: #2563eb; }
    `}</style>
    <div className="worlds-reload-footer">
      <Tooltip label={status?.changed ? 'Preview changes to worlds and skills' : 'Reload worlds'} side="bottom">
        <button className="worlds-reload-entry" aria-label={status?.changed ? 'Worlds config changed. Reload?' : 'Reload worlds'} data-changed={status?.changed ?? false} disabled={busy || status?.applying} onClick={() => { void inspect(); }}>
          {status?.changed && <span className="worlds-reload-dot" aria-hidden="true" />}
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
        </button>
      </Tooltip>
    </div>
    <dialog ref={dialog} className="worlds-reload-dialog" aria-labelledby="worlds-reload-title" onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id="worlds-reload-title">Reload worlds</h2>
      {busy && <p role="status">{preview ? `Applying changes… ${status?.completed ?? 0}/${preview.skills.length}${status?.current ? ` · ${status.current}` : ''}` : 'Checking config and remote skills…'}</p>}
      {error && <p role="alert">{error}</p>}
      {preview && <>
        <p className="reload-note">Preview only. No remote changes have been made. Existing Sessions keep their saved World and workspace.</p>
        <h3>Worlds & workspaces</h3>
        {!preview.changes.length && <p>No catalog changes.</p>}
        {preview.changes.map((change, i) => <details key={i}><summary>{change.world} · {change.kind}</summary><pre>{change.detail}</pre></details>)}
        <h3>Remote skills</h3>
        <p className="reload-note">Skills are shared by workspaces using the same remote account. Removing a skill unlinks this extension’s managed copy; stored versions are retained.</p>
        {!preview.skills.length && <p>No managed skill changes.</p>}
        {preview.skills.map((skill, i) => <details key={i}><summary>{skill.action === 'remove' ? '−' : skill.action === 'add' ? '+' : skill.action === 'update' ? '↻' : '='} {skill.world} / {skill.name} · {skill.action}</summary>
          <pre>{`Target: ${skill.target}\n${skill.source ? `Source: ${skill.source}\n` : ''}Before: ${skill.before.split(':')[0]}\nAfter: ${skill.after ?? 'Disabled (versions retained)'}`}</pre>
          {skill.files.items.length > 0 && <details><summary>File changes (+{skill.files.counts.add} / ~{skill.files.counts.update} / −{skill.files.counts.remove})</summary>
            <pre>{skill.files.items.map(file => `${file.action === 'add' ? '+' : file.action === 'remove' ? '−' : '~'} ${file.path}${file.directory ? '/' : ''}`).join('\n')}</pre>
            {skill.files.truncated && <p className="reload-note">Showing {skill.files.items.length} paths. The full counts above include all changes.</p>}
          </details>}
        </details>)}
        {preview.errors.map((error, i) => <p role="alert" key={i}>{error}</p>)}
      </>}
      {result && <>
        <p role="status">{result.applied ? 'Worlds reloaded.' : 'Some changes failed. Automatic skill sync is paused; preview again to finish the remaining changes.'}</p>
        {result.results.map((item, i) => <p key={i} role={item.ok ? undefined : 'alert'}>{item.world} / {item.skill}: {item.ok ? 'Applied' : item.error}</p>)}
      </>}
      <footer>
        <button disabled={busy && !!preview} onClick={close}>{result?.applied ? 'Close' : 'Cancel'}</button>
        {!result?.applied && <button disabled={busy} onClick={() => { void inspect(); }}>Preview again</button>}
        {preview && <button className="reload-apply" disabled={busy || !!preview.errors.length} onClick={() => { void apply(); }}>Apply changes</button>}
      </footer>
    </dialog>
  </>;
}
