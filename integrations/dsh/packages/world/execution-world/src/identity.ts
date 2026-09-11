import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';

const identifier = z.string().min(1).max(512).regex(/^[^\0\r\n]+$/);
const path = identifier.refine(value => value.startsWith('/'), 'Absolute path required');
const sshWorldSchema = z.object({
  id: identifier, kind: z.literal('ssh'), host: identifier.refine(value => !value.startsWith('-')),
  configFile: path.optional(), installRoot: path.optional(), runtimeBase: path.optional(),
  podmanContainer: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const localWorldSchema = z.object({ id: identifier, kind: z.literal('local') }).strict();
const worldSchema = z.discriminatedUnion('kind', [sshWorldSchema, localWorldSchema]);
const sshWorkspaceSchema = sshWorldSchema.extend({ worldId: identifier, cwd: path });
const localWorkspaceSchema = localWorldSchema.extend({ worldId: identifier, cwd: path });
export const workspaceSchema = z.discriminatedUnion('kind', [sshWorkspaceSchema, localWorkspaceSchema]);
export type SshWorldDefinition = Readonly<z.infer<typeof sshWorldSchema>>;
export type WorldDefinition = SshWorldDefinition | Readonly<z.infer<typeof localWorldSchema>>;
export type SshWorkspaceDefinition = Readonly<z.infer<typeof sshWorkspaceSchema>>;
export type WorkspaceDefinition = SshWorkspaceDefinition | Readonly<z.infer<typeof localWorkspaceSchema>>;
export type WorldTarget = Omit<SshWorldDefinition, 'id'> | { kind: 'local' };

export function worldDefinition(input: unknown): WorldDefinition {
  const result = worldSchema.safeParse(input);
  if (!result.success) throw new RemoteError('INVALID_WORLD', 'Invalid World definition');
  return Object.freeze(result.data);
}

export function workspaceDefinition(input: unknown): WorkspaceDefinition {
  const result = workspaceSchema.safeParse(input);
  if (!result.success) throw new RemoteError('INVALID_WORLD', 'Invalid workspace execution definition');
  return Object.freeze(result.data);
}

/** Callers obtain canonical cwd from the explicitly selected World's filesystem. */
export function workspaceFor(world: WorldDefinition, id: string, cwd: string): WorkspaceDefinition {
  return workspaceDefinition({ ...worldDefinition(world), worldId: world.id, id, cwd });
}

// Schema parsing fixes property order and excludes fields outside execution identity.
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const worldFingerprint = (world: WorldDefinition): string => fingerprint(worldDefinition(world));
export const workspaceFingerprint = (workspace: WorkspaceDefinition): string => fingerprint(workspaceDefinition(workspace));
export const sameWorkspace = (left: WorkspaceDefinition, right: WorkspaceDefinition): boolean => workspaceFingerprint(left) === workspaceFingerprint(right);
export function targetFingerprint(target: WorldTarget): string {
  const value = target.kind === 'local' ? { kind: target.kind } : {
    kind: target.kind, host: target.host, configFile: target.configFile, installRoot: target.installRoot,
    runtimeBase: target.runtimeBase, podmanContainer: target.podmanContainer,
  };
  return worldFingerprint(worldDefinition({ ...value, id: 'target' }));
}

