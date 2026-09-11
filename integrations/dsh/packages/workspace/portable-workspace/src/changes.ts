/** Coalesced invalidations with an opening snapshot and request-owned cancellation. */
export async function* changes(source: { subscribe(listener: () => void): () => void }, signal: AbortSignal): AsyncIterable<void> {
  let dirty = true;
  let wake: (() => void) | undefined;
  const changed = () => { dirty = true; wake?.(); };
  const unsubscribe = source.subscribe(changed);
  signal.addEventListener('abort', changed);
  try {
    while (!signal.aborted) {
      if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      if (signal.aborted) break;
      dirty = false;
      yield;
    }
  } finally { unsubscribe(); signal.removeEventListener('abort', changed); }
}
