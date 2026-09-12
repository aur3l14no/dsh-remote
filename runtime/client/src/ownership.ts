import { RemoteError } from './protocol.ts';

/** Cancellation and cleanup for one borrower of a shared runtime. */
export class ResourceScope {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources = new Set<() => Promise<void>>();
  private closing?: Promise<void>;

  signal(input?: AbortSignal): AbortSignal {
    this.controller.signal.throwIfAborted();
    return input ? AbortSignal.any([input, this.controller.signal]) : this.controller.signal;
  }
  async run<T>(input: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.signal(input);
    const pending = Promise.resolve().then(() => action(signal));
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }
  own(cleanup: () => Promise<void>): () => Promise<void> {
    this.controller.signal.throwIfAborted();
    let pending: Promise<void> | undefined;
    // An unconfirmed release remains owned so later close cannot report success.
    const release = () => pending ??= Promise.resolve().then(cleanup).then(() => { this.resources.delete(release); });
    this.resources.add(release);
    return release;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(new RemoteError('OWNER_CLOSED', 'Runtime resource owner is closed'));
    return this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.resources].map(release => release()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime owner cleanup failed');
    })();
  }
}
