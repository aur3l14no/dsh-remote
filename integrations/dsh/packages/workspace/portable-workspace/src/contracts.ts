import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';

export interface WorldView { id: string; name: string; color: string; workspaceIds: string[]; skills: { name: string; enabled: boolean }[] }
export interface WorldSettings { worldId: string; color: string; enabledSkills: string[] }
export interface PortableWorkspaceSelection { worldId: string; path: string }
export interface PortableWorkspaceRemote {
  configureWorld(request: WorldSettings): Promise<RemoteResult<WorldView[]>>;
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
