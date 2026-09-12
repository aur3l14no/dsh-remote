import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { worldFingerprint, type SshWorldDefinition } from '../../execution-world/src/identity.ts';
import type { WorldConnection, WorldConnector } from './adapter.ts';

interface Entry { pending: Promise<WorldConnection>; leases: number; closing?: Promise<void> }

/** One controller per explicit World configuration; workspace owners only borrow it. */
export class WorldRuntimePool {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly connect: WorldConnector) {}

  async acquire(definition: SshWorldDefinition): Promise<{ connection: WorldConnection; release(): Promise<void> }> {
    const key = worldFingerprint(definition);
    let entry = this.entries.get(key);
    if (entry?.closing) {
      await entry.closing;
      return this.acquire(definition);
    }
    if (!entry) {
      entry = { pending: Promise.resolve().then(() => this.connect(definition)), leases: 0 };
      this.entries.set(key, entry);
    }
    entry.leases++;
    const owned = entry;
    let released: Promise<void> | undefined;
    const release = () => released ??= (async () => {
      if (--owned.leases !== 0) return;
      // Keep the entry until shutdown settles so a new opener cannot race cleanup.
      owned.closing = (async () => {
        let connection: WorldConnection;
        try { connection = await owned.pending; }
        catch (error) { this.entries.delete(key); throw error; }
        await connection.close();
        if (this.entries.get(key) === owned) this.entries.delete(key);
      })();
      await owned.closing;
    })();
    try {
      const connection = await owned.pending;
      if (connection.client.info.world !== definition.id) throw new RemoteError('WORLD_MISMATCH', 'Helper World differs from the requested World');
      if (!['ready', 'reconnecting'].includes(connection.client.state)) throw new RemoteError('WORLD_LOST', 'Shared World runtime is unavailable');
      return { connection, release };
    } catch (error) {
      try { await release(); } catch (cleanup) {
        if (cleanup !== error) throw new AggregateError([error, cleanup], 'World acquisition failed with unconfirmed cleanup');
      }
      throw error;
    }
  }
}
