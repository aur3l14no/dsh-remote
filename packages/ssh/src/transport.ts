import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { Client, RemoteError } from '../../client/src/index.ts';
import type { TransportFactory } from '../../client/src/index.ts';

export interface SshTarget {
  host: string;
  configFile?: string;
  /** Optional final environment: a running Podman container pinned by its full immutable ID. */
  podmanContainer?: string;
}
export interface SuppliedRuntime extends SshTarget {
  world: string;
  helper: string;
  socket: string;
  connectTimeoutMs?: number;
  required?: string[];
}

/** POSIX control-command quoting; Agent argv is transported by process.spawn instead. */
export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not allowed in SSH control arguments');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshArguments(target: SshTarget, command: readonly string[]): string[] {
  if (!target.host || target.host.startsWith('-') || /[\0\r\n]/.test(target.host)) throw new Error('Invalid SSH host');
  if (target.podmanContainer !== undefined && (target.podmanContainer.length !== 64 || !/^[a-f0-9]{64}$/.test(target.podmanContainer))) {
    throw new RemoteError('INVALID_ARGUMENT', 'Podman transport requires the full container ID, never a reusable name');
  }
  const final = target.podmanContainer === undefined ? command : ['podman', 'exec', '-i', target.podmanContainer, ...command];
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(target.configFile ? ['-F', target.configFile] : []), '--', target.host, final.map(quote).join(' ')];
}

/** Uses an already installed helper/socket; bootstrap owns provisioning separately. */
export function sshTransport(target: SuppliedRuntime): TransportFactory {
  if (!target.helper.startsWith('/') || !target.socket.startsWith('/')) throw new Error('Explicit absolute helper and socket paths are required');
  const argv = sshArguments(target, [target.helper, 'connect', '--socket', target.socket]);
  return async signal => {
    signal.throwIfAborted();
    const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // Drain diagnostics boundedly without exposing account/config details or credentials as protocol data.
    child.stderr.resume();
    child.on('error', () => transport.destroy(new RemoteError('SSH_FAILED', 'Could not start system OpenSSH')));
    child.on('exit', code => {
      if (code !== 0) transport.destroy(new RemoteError('SSH_FAILED', 'OpenSSH connection ended unsuccessfully'));
    });
    const abort = () => transport.destroy(new RemoteError('CONNECT_TIMEOUT', 'SSH connection attempt aborted'));
    signal.addEventListener('abort', abort, { once: true });
    transport.once('close', () => {
      signal.removeEventListener('abort', abort);
      child.kill();
    });
    return transport;
  };
}

export function connectSuppliedRuntime(target: SuppliedRuntime): Promise<Client> {
  return Client.open({ world: target.world, connect: sshTransport(target), connectTimeoutMs: target.connectTimeoutMs, required: ['fs.bytes', 'fs.atomic-publish', 'process.pipe', 'output.ack', 'output.collect', ...(target.required ?? [])] });
}
