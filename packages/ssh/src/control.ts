import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RemoteError } from '../../client/src/index.ts';
import { sshArguments } from './transport.ts';
import type { SshTarget } from './transport.ts';

export interface ControlOptions { input?: Readable; signal?: AbortSignal; timeoutMs?: number }
export type Control = (argv: readonly string[], options?: ControlOptions) => Promise<string>;

/** Bounded control-plane output; stdout is data, SSH diagnostics are never parsed as a protocol. */
export function execute(command: string, args: readonly string[], options: ControlOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let failure: unknown;
    const stop = (error: unknown) => { failure ??= error; child.kill(); options.input?.destroy(); };
    const abort = () => stop(new RemoteError('CANCELLED', 'Bootstrap was cancelled'));
    const timer = setTimeout(() => stop(new RemoteError('CONTROL_TIMEOUT', 'Remote control deadline exceeded')), options.timeoutMs ?? 20000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) stop(new RemoteError('CONTROL_OUTPUT_LIMIT', 'Remote control output exceeded limit'));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {}); // The pipeline/exit outcome reports input failure without an unhandled stream event.
    child.on('error', () => { failure ??= new RemoteError('CONTROL_FAILED', 'Could not start control transport'); });
    const input = options.input ? pipeline(options.input, child.stdin).catch(error => { failure ??= error; child.kill(); }) : Promise.resolve(child.stdin.end());
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void input.then(() => {
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new RemoteError('CONTROL_FAILED', 'Remote control command failed', { exitCode: code, signal })); return; }
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new RemoteError('CONTROL_PROTOCOL', 'Invalid UTF-8 in remote control response')); }
      });
    });
  });
}

export function sshControl(target: SshTarget): Control {
  return (argv, options) => execute('ssh', sshArguments(target, argv), options);
}
