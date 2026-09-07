import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';

export interface WorldView { id: string; name: string }
export interface PortableWorkspaceSelection { worldId: string; path: string }
export interface PortableWorkspaceRemote {
  worlds(): Promise<RemoteResult<WorldView[]>>;
  create(request: PortableWorkspaceSelection): Promise<RemoteResult<{ workspaceId: WorkspaceId }>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { portableWorkspace: PortableWorkspaceRemote }
}
