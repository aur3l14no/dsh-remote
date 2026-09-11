import type { Context } from '@deepseek-ai/cordis';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';

declare module '@deepseek-ai/cordis' { interface Context { nativeWorkspaceRegistry: WorkspaceRegistry } }

/** Native durable membership in its own service realm; no cwd-based history adoption. */
export const inject = ['storageDomain', 'sessionPersistence'];
export async function apply(ctx: Context): Promise<void> {
  const owner = ctx.isolate('workspaceRegistry');
  await owner.plugin(WorkspaceRegistry, { bootstrapHistory: false });
  await owner.plugin({ inject: ['workspaceRegistry'], apply(ctx: Context) {
    ctx.provide('nativeWorkspaceRegistry', ctx.workspaceRegistry);
  } });
}
