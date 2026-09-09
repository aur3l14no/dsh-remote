import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';

export interface WorldView { id: string; name: string }
export interface PortableWorkspaceSelection { worldId: string; path: string }
export interface PortableWorkspaceRemote {
  hosts(): Promise<RemoteResult<string[]>>;
  connect(request: { host: string }): Promise<RemoteResult<{ world: WorldView; home: string }>>;
  directories(request: PortableWorkspaceSelection): Promise<RemoteResult<string[]>>;
  worlds(): Promise<RemoteResult<WorldView[]>>;
  create(request: PortableWorkspaceSelection): Promise<RemoteResult<{ workspaceId: WorkspaceId }>>;
  syncSkills(request: { worldId: string }): Promise<RemoteResult<{ count: number }>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { portableWorkspace: PortableWorkspaceRemote }
}
