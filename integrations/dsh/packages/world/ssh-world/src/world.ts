import { Context, Service } from '@deepseek-ai/cordis';
import { Client, RemoteError } from '../../../../../../runtime/client/src/index.ts';

declare module '@deepseek-ai/cordis' {
  interface Context { remoteWorld: RemoteWorld }
}

/** A composition owns one already-negotiated runtime; each provider owns its allocations. */
export class RemoteWorld extends Service {
  readonly client: Client;
  /** Persistent remote account data, separate from installations and runtime cleanup. */
  readonly dataRoot?: string;
  private owners = new Set<() => Promise<void>>();
  constructor(ctx: Context, client: Client, close: () => Promise<void> = () => client.shutdown(), dataRoot?: string) {
    super(ctx, 'remoteWorld');
    if (client.state !== 'ready') throw new RemoteError('WORLD_NOT_READY', 'Bind a negotiated World before loading consumers');
    this.client = client;
    this.dataRoot = dataRoot;
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.owners].map(dispose => dispose()));
      await close();
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'World owner cleanup failed');
    });
  }
  registerOwner(cleanup: () => Promise<void>): () => Promise<void> {
    let pending: Promise<void> | undefined;
    const dispose = () => pending ??= cleanup().finally(() => this.owners.delete(dispose));
    this.owners.add(dispose);
    return dispose;
  }
}

/** Embed in the same isolated Loader group as FS, subprocess and their consumers. */
export function worldPlugin(client: Client, close?: () => Promise<void>, dataRoot?: string): new (ctx: Context) => RemoteWorld {
  return class BoundWorld extends RemoteWorld {
    constructor(ctx: Context) { super(ctx, client, close, dataRoot); }
  };
}
