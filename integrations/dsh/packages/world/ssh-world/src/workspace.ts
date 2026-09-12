import { Context, Service } from '@deepseek-ai/cordis';
import { Client, RemoteError, ResourceScope } from '../../../../../../runtime/client/src/index.ts';

declare module '@deepseek-ai/cordis' {
  interface Context { remoteWorkspace: RemoteWorkspace }
}

/** A workspace view borrows a negotiated World runtime and owns only its allocations. */
export class RemoteWorkspace extends Service {
  readonly client: Client;
  /** Persistent remote account data, separate from installations and runtime cleanup. */
  readonly dataRoot?: string;
  readonly resources = new ResourceScope();
  constructor(ctx: Context, client: Client, readonly cwd: string, close: () => Promise<void> = () => client.shutdown(), dataRoot?: string) {
    super(ctx, 'remoteWorkspace');
    if (client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Bind a negotiated World before loading consumers');
    if (!cwd.startsWith('/')) throw new RemoteError('INVALID_ARGUMENT', 'Workspace cwd must be absolute');
    this.client = client;
    this.dataRoot = dataRoot;
    ctx.effect(() => async () => {
      const failures: unknown[] = [];
      try { await this.resources.close(); } catch (error) { failures.push(error); }
      try { await close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Workspace cleanup failed');
    });
  }
  registerOwner(cleanup: () => Promise<void>): () => Promise<void> {
    return this.resources.own(cleanup);
  }
}

/** Embed in the same isolated Loader group as FS, subprocess and their consumers. */
export function workspacePlugin(client: Client, cwd: string, close?: () => Promise<void>, dataRoot?: string): new (ctx: Context) => RemoteWorkspace {
  return class BoundWorkspace extends RemoteWorkspace {
    constructor(ctx: Context) { super(ctx, client, cwd, close, dataRoot); }
  };
}
