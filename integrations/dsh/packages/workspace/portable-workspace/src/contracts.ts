import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';

export interface WorldView { kind: 'local' | 'ssh'; id: string; name: string; color: string; workspaceIds: string[]; pinnedSessionIds: string[]; workspaces: { name?: string; path: string }[] }
export interface PortableWorkspaceSelection { worldId: string; path: string }
export interface PortableWorkspaceRemote {
  reloadStatus(): Promise<RemoteResult<ReloadStatus>>;
  previewReload(): Promise<RemoteResult<ReloadPreview>>;
  applyReload(request: { id: string }): Promise<RemoteResult<ReloadResult>>;
  cancelReload(request: { id: string }): Promise<RemoteResult<void>>;
  pinSession(request: { sessionId: string; pinned: boolean }): Promise<RemoteResult<WorldView[]>>;
  worlds(): Promise<RemoteResult<WorldView[]>>;
  create(request: PortableWorkspaceSelection): Promise<RemoteResult<{ workspaceId: WorkspaceId }>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { portableWorkspace: PortableWorkspaceRemote }
}

export interface ReloadStatus { changed: boolean; applying: boolean; generation: number; error?: string; current?: string; completed: number; total: number }
export interface ReloadChange { world: string; kind: string; detail: string }
export interface ReloadFileChange { path: string; action: 'add' | 'update' | 'remove'; directory: boolean }
export interface ReloadSkill { world: string; target: string; name: string; action: 'add' | 'update' | 'remove' | 'unchanged'; source?: string; before: string; after?: string; files: { items: ReloadFileChange[]; counts: { add: number; update: number; remove: number }; truncated: boolean } }
export interface ReloadPreview { id: string; changes: ReloadChange[]; skills: ReloadSkill[]; errors: string[] }
export interface ReloadResult { applied: boolean; results: { world: string; skill: string; ok: boolean; error?: string }[] }
