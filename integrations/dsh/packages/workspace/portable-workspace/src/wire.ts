import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';
import { z } from 'zod';

const codec = (name: string, schema: z.ZodType): TypertCodec => ({ mode: 'strict', typeSymbol: `portableWorkspace#${name}`, schema });
const worldView = z.object({ id: z.string(), name: z.string(), color: z.string(), workspaceIds: z.array(z.string()), pinnedSessionIds: z.array(z.string()), workspaces: z.array(z.object({ name: z.string().optional(), path: z.string() })) });
const reloadStatus = z.object({ changed: z.boolean(), applying: z.boolean(), generation: z.number(), error: z.string().optional(), current: z.string().optional(), completed: z.number(), total: z.number() });
const reloadPreview = z.object({ id: z.string(), errors: z.array(z.string()),
  changes: z.array(z.object({ world: z.string(), kind: z.string(), detail: z.string() })),
  skills: z.array(z.object({ world: z.string(), target: z.string(), name: z.string(), action: z.enum(['add', 'update', 'remove', 'unchanged']), source: z.string().optional(), before: z.string(), after: z.string().optional(), files: z.object({ items: z.array(z.object({ path: z.string(), action: z.enum(['add', 'update', 'remove']), directory: z.boolean() })), counts: z.object({ add: z.number(), update: z.number(), remove: z.number() }), truncated: z.boolean() }) })) });
const reloadResult = z.object({ applied: z.boolean(), results: z.array(z.object({ world: z.string(), skill: z.string(), ok: z.boolean(), error: z.string().optional() })) });
export const contribution: TypertContribution = {
  package: '@dsh-remote/portable-workspace', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
  invocations: [
    ...[['reloadStatus', reloadStatus], ['previewReload', reloadPreview], ['applyReload', reloadResult], ['cancelReload', z.void()]].map(([method, schema]) => ({
      id: `@dsh-remote/portable-workspace#portableWorkspace/${method}`, service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: method as string,
      invocation: { kind: 'direct' as const }, parameters: method === 'applyReload' || method === 'cancelReload' ? [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('ReloadId', z.object({ id: z.string().min(1) }).strict()) }] : [],
      result: codec(method as string, schema as z.ZodType),
    })),
    { id: '@dsh-remote/portable-workspace#portableWorkspace/pinSession', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'pinSession',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: codec('PinSession', z.object({ sessionId: z.string().min(1), pinned: z.boolean() }).strict()) }],
      result: codec('Pinned', z.array(worldView)) },
    { id: '@dsh-remote/portable-workspace#portableWorkspace/worlds', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'worlds',
      invocation: { kind: 'direct' }, parameters: [], result: codec('Worlds', z.array(worldView)) },
    { id: '@dsh-remote/portable-workspace#portableWorkspace/create', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'create',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: codec('Selection', z.object({ worldId: z.string().min(1), path: z.string().min(1) }).strict()) }],
      result: codec('Created', z.object({ workspaceId: z.string() })) },
  ],
};
