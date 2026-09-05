import { Client, RemoteError } from '../../client/src/index.ts';

/** Public, stable declaration; target is an opaque deployment identity, never SSH credentials. */
export interface WorldIdentity { readonly id: string; readonly target: string; readonly cwd: string }
export interface WorldConnection { readonly client: Client; readonly ripgrep: string; close(): Promise<void> }
export interface WorldDefinition extends WorldIdentity {
  /** Bounded provisioning; shared startup is not cancelled by any one lease. */
  readonly open: () => Promise<WorldConnection>;
}
interface Entry { refs: number; ready: Promise<WorldConnection> }

/** One runtime per live World, with independent Agent leases and no restart recovery. */
export class WorldPool {
  private definitions = new Map<string, Readonly<WorldDefinition>>();
  private entries = new Map<string, Entry>();
  constructor(definitions: readonly WorldDefinition[]) {
    for (const definition of definitions) {
      if (!definition.id || !definition.target || !definition.cwd.startsWith('/') || definition.cwd.includes('\0') || this.definitions.has(definition.id)) throw new Error('World declarations require unique IDs, target identities and absolute cwd');
      this.definitions.set(definition.id, Object.freeze({ ...definition }));
    }
  }
  definition(id: string): Readonly<WorldDefinition> {
    const definition = this.definitions.get(id);
    if (!definition) throw new RemoteError('UNKNOWN_WORLD', 'Select a configured World');
    return definition;
  }
  acquire(id: string) {
    const definition = this.definition(id);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { refs: 0, ready: Promise.resolve().then(() => definition.open()).then(async connection => {
        try {
          const { client, ripgrep } = connection;
          if (client.state !== 'ready' || client.info.world !== id || client.info.cwd !== definition.cwd || !ripgrep.startsWith('/')) throw new RemoteError('WORLD_MISMATCH', 'Negotiated World or canonical cwd differs from its declaration');
          return connection;
        } catch (error) { await connection.close(); throw error; }
      }) };
      this.entries.set(id, entry);
    }
    entry.refs++;
    const acquired = entry;
    let released: Promise<void> | undefined;
    return { ready: acquired.ready, release: (): Promise<void> => released ??= (async () => {
      if (--acquired.refs !== 0) return;
      if (this.entries.get(id) === acquired) this.entries.delete(id);
      // A late successful bootstrap remains owned even if every Agent setup was aborted.
      let connection: WorldConnection;
      try { connection = await acquired.ready; } catch { return; }
      await connection.close();
    })() };
  }
}
