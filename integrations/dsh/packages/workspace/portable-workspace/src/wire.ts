import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';
import { z } from 'zod';

const codec = (name: string, schema: z.ZodType): TypertCodec => ({ mode: 'strict', typeSymbol: `portableWorkspace#${name}`, schema });
export const contribution: TypertContribution = {
  package: '@dsh-remote/portable-workspace', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
  invocations: [
    { id: '@dsh-remote/portable-workspace#portableWorkspace/syncSkills', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'syncSkills',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: codec('SkillWorld', z.object({ worldId: z.string().min(1) }).strict()) }],
      result: codec('SkillsSynced', z.object({ count: z.number().int().nonnegative() })) },
    { id: '@dsh-remote/portable-workspace#portableWorkspace/worlds', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'worlds',
      invocation: { kind: 'direct' }, parameters: [], result: codec('Worlds', z.array(z.object({ id: z.string(), name: z.string() }))) },
    { id: '@dsh-remote/portable-workspace#portableWorkspace/create', service: 'portableWorkspaceApi', namespace: 'portableWorkspace', method: 'create',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: codec('Selection', z.object({ worldId: z.string().min(1), path: z.string().min(1) }).strict()) }],
      result: codec('Created', z.object({ workspaceId: z.string() })) },
  ],
};
