import { Client, RemoteError, RemoteProcess } from '../../client/src/index.ts';
import { parseManifest, selectBundle } from './manifest.ts';
import { sshControl } from './control.ts';
import type { Control } from './control.ts';
import { connectSuppliedRuntime } from './transport.ts';
import type { SshTarget } from './transport.ts';
import { install, probe, remotePath, script } from './provision.ts';
import type { Installation, Probe } from './provision.ts';

export interface BootstrapOptions extends SshTarget {
  world: string;
  cwd: string;
  /** Trusted release metadata. The target never supplies executable provenance. */
  manifest: unknown;
  /** Local files named by SHA-256; populated explicitly or by the caller's trusted downloader. */
  cacheDir: string;
  installRoot?: string;
  runtimeBase?: string;
  graceMs?: number;
  leaseMs?: number;
  connectTimeoutMs?: number;
  lockWaitMs?: number;
  required?: string[];
  signal?: AbortSignal;
}
export interface SshWorld {
  client: Client;
  installation: Installation;
  platform: Probe;
  /** Exact installed executable identity for the DSH managed-executable map. */
  ripgrep: string;
  /** Confirms runtime shutdown before removing only this World's temporary parent directory. */
  close(): Promise<void>;
}

export function bootstrapSshWorld(options: BootstrapOptions): Promise<SshWorld> {
  const target = { host: options.host, configFile: options.configFile, podmanContainer: options.podmanContainer };
  return provisionWorld(sshControl(target), args => connectSuppliedRuntime({ ...target, ...args }), options);
}

type Connection = (args: { world: string; helper: string; socket: string; connectTimeoutMs: number; required: string[] }) => Promise<Client>;

/** Internal resolver seam. Native acceptance injects an explicit local control/transport pair. */
export async function provisionWorld(control: Control, connect: Connection, options: Omit<BootstrapOptions, keyof SshTarget>): Promise<SshWorld> {
  if (!options.world || /[\0\r\n]/.test(options.world)) throw new RemoteError('INVALID_ARGUMENT', 'Explicit World identity required');
  const manifest = parseManifest(options.manifest);
  const bounded = (value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new RemoteError('INVALID_ARGUMENT', 'Unsupported bootstrap timing budget');
    return value;
  };
  const graceMs = bounded(options.graceMs ?? 30000, 100, 300000);
  const leaseMs = bounded(options.leaseMs ?? 10000, 100, 300000);
  const connectTimeoutMs = bounded(options.connectTimeoutMs ?? 15000, 100, 60000);
  const required = [...(options.required ?? [])];
  const runtimeBase = remotePath(options.runtimeBase ?? '/tmp');
  options.signal?.throwIfAborted();
  const platform = await probe(control, options.cwd, options.installRoot, options.signal);
  const bundle = selectBundle(manifest, platform);
  const installation = await install(control, platform, bundle, options.cacheDir, { signal: options.signal, lockWaitMs: options.lockWaitMs });
  const parent = remotePath((await script(control, 'cd "$1"\nmktemp -d "$(pwd -P)/dsh-world.XXXXXXXX"\n', [runtimeBase], { signal: options.signal })).replace(/\n$/, ''));
  const socket = `${parent}/runtime/socket`;
  if (!/\/dsh-world\.[A-Za-z0-9]{8}$/.test(parent)) throw new RemoteError('CONTROL_PROTOCOL', 'Invalid runtime parent');
  if (Buffer.byteLength(socket) > 100) {
    await script(control, 'rmdir "$1"\n', [parent]);
    throw new RemoteError('RUNTIME_PATH_TOO_LONG', 'Select a shorter runtime base for Unix sockets');
  }
  let client: Client | undefined;
  let startAttempted = false;
  try {
    startAttempted = true;
    const started = await control([installation.helper, 'start', '--runtime-dir', `${parent}/runtime`, '--cwd', platform.cwd,
      '--grace-ms', String(graceMs), '--lease-ms', String(leaseMs)], { signal: options.signal, timeoutMs: connectTimeoutMs });
    if (started !== '{"started":true}\n') throw new RemoteError('CONTROL_PROTOCOL', 'Unexpected runtime startup response');
    client = await connect({ world: options.world, helper: installation.helper, socket, connectTimeoutMs, required });
    options.signal?.throwIfAborted();
    if (client.info.build !== bundle.helper.version || client.info.platform !== platform.os || client.info.arch !== platform.arch || client.info.cwd !== platform.cwd) throw new RemoteError('RUNTIME_MISMATCH', 'Negotiated runtime differs from selected installation');
    const check = await RemoteProcess.spawn(client, { argv: [installation.ripgrep, '--version'], cwd: platform.cwd, stdin: 'ignore', graceMs: 500, drainMs: 500,
      stdout: { mode: 'collect', maxBytes: 32768 }, stderr: { mode: 'collect', maxBytes: 32768 } });
    const interrupted = Promise.withResolvers<never>();
    const abort = () => interrupted.reject(new RemoteError('CANCELLED', 'Bootstrap validation cancelled'));
    const timer = setTimeout(() => interrupted.reject(new RemoteError('VALIDATION_TIMEOUT', 'Managed ripgrep validation timed out')), connectTimeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      if ((await Promise.race([check.done, interrupted.promise])).rootExit?.code !== 0 || check.collected[0]!.readFrom(0).text.split('\n')[0]!.split(' ').slice(0, 2).join(' ') !== `ripgrep ${bundle.ripgrep.version}`) throw new RemoteError('ARTIFACT_EXEC_FAILED', 'Managed ripgrep failed through the negotiated runtime');
    } catch (error) { await check.terminate(); throw error; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); await check.release(); }
    options.signal?.throwIfAborted();
    const ready = client;
    let closing: Promise<void> | undefined;
    return { client: ready, installation, platform, ripgrep: installation.ripgrep,
      close() {
        return closing ??= (async () => {
          await ready.shutdown();
          ready.dispose();
          await script(control, 'rm -rf "$1"\n', [parent], { timeoutMs: 10000 });
        })();
      } };
  } catch (error) {
    if (client) {
      try { await client.shutdown(); await script(control, 'rm -rf "$1"\n', [parent], { timeoutMs: 10000 }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Bootstrap failed with unconfirmed cleanup'); }
      finally { client.dispose(); }
    } else if (!startAttempted) await script(control, 'rmdir "$1"\n', [parent]).catch(() => {});
    // Without hello credentials, no workspace requests are admitted; a started helper expires after finite grace.
    throw error;
  }
}
