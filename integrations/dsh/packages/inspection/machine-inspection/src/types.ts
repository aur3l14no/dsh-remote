export interface MachineObservation {
  version: 1;
  worldId: string;
  workspaceId: string;
  sessionId: string;
  sampledAt: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  cpuCount: number | null;
  memoryTotalMiB: number | null;
  memoryAvailableMiB: number | null;
  uptimeSeconds: number | null;
  addresses: { interface: string; address: string; family: string; state: string }[];
  defaultRoutes: string[];
  disks: string | null;
  errors: { probe: string; message: string }[];
}
export interface InspectionAttempt {
  id: string;
  worldId: string;
  name: string;
  childId: string;
  status: 'preparing' | 'started' | 'failed' | 'cancelled';
  at: string;
  workspaceId?: string;
  path?: string;
  error?: string;
}
export interface MachineMapNode extends InspectionAttempt {
  state: 'preparing' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  observation?: MachineObservation;
}
