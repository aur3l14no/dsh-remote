import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../client/src/index.ts';
import type { TransportFactory } from '../../client/src/index.ts';

export const helper = resolve(process.env.DSH_TEST_HELPER ?? 'runtime/helper/target/debug/dsh-remote-helper');
export const fixture = resolve(process.env.DSH_TEST_FIXTURE ?? 'runtime/helper/target/debug/dsh-remote-fixture');

export async function runtime(options: { world?: string; cwd?: string; grace?: number; lease?: number; wrap?: (factory: TransportFactory) => TransportFactory } = {}) {
  const dir = await mkdtemp('/tmp/dsh-client.');
  const runtimeDir = join(dir, 'runtime');
  const child = spawn(helper, ['serve', '--runtime-dir', runtimeDir, '--cwd', options.cwd ?? dir, '--grace-ms', String(options.grace ?? 3000), '--lease-ms', String(options.lease ?? 1000)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  const connect: TransportFactory = async signal => {
    signal.throwIfAborted();
    const socket = createConnection(join(runtimeDir, 'socket'));
    await new Promise<void>((resolve, reject) => {
      const abort = () => { socket.destroy(); reject(new Error('Connection aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => { signal.removeEventListener('abort', abort); resolve(); });
      socket.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    });
    return socket;
  };
  let client: Client | undefined;
  try {
    // Avoid opening an unbound controller while waiting for socket creation.
    const { access } = await import('node:fs/promises');
    for (let i = 0; ; i++) {
      try { await access(join(runtimeDir, 'socket')); break; } catch { if (i === 100) throw new Error('Helper did not start'); await delay(20); }
    }
    client = await Client.open({ world: options.world ?? 'client-test', connect: options.wrap?.(connect) ?? connect });
    return { client, dir: client.info.cwd, runtimeDir, connect, child,
      async close() {
        if (client!.state === 'ready' || client!.state === 'reconnecting') await client!.shutdown().catch(() => {});
        client!.dispose(); child.kill('SIGTERM'); await exited;
        await rm(dir, { recursive: true, force: true });
      } };
  } catch (error) { client?.dispose(); child.kill(); await exited; await rm(dir, { recursive: true, force: true }); throw error; }
}
