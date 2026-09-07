export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Params = { [key: string]: Json };
export type ClientState = 'starting' | 'ready' | 'reconnecting' | 'closing' | 'closed' | 'failed';

export class RemoteError extends Error {
  readonly code: string;
  readonly details?: Json;
  constructor(code: string, message: string, details?: Json) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.details = details;
  }
}

export interface Hello {
  api: 1;
  build: string;
  runtime: string;
  token: string;
  world: string;
  cwd: string;
  platform: string;
  arch: string;
  capabilities: string[];
  graceMs: number;
  leaseMs: number;
  requestHighWater: number;
  limits: Record<string, number>;
  inputWaiting: 'unknown';
  cleanupScope: 'observed-session-members';
}

export interface Snapshot {
  stream: string;
  mode: 'raw' | 'collect';
  offset: number;
  next: number;
  produced: number;
  retainedFrom: number;
  gap: boolean;
  data: string;
  eof: boolean;
  error: { code: string; message: string; details?: Json } | null;
  spill: string | null;
  revision: number;
}

export interface ProcessState {
  process: string;
  pid: number;
  rootExit: { code: number | null; signal: number | null; signalName?: string | null; coreDumped: boolean } | null;
  closed: boolean;
  cleanupComplete: boolean;
  observationError: { code: string; message: string } | null;
  terminationAccepted: boolean;
  termSent: boolean;
  killSent: boolean;
  revision: number;
}

export interface Spawned {
  process: string;
  pid: number;
  outputs: { stream: string; mode: 'raw' | 'collect' }[];
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError('Expected an object');
  return value as Record<string, unknown>;
}

export function protocolError(message: string): RemoteError {
  return new RemoteError('PROTOCOL_ERROR', message);
}

export function decodeBytes(data: string): Buffer {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw protocolError('Noncanonical Base64 payload');
  return bytes;
}

export function snapshot(value: unknown): Snapshot {
  const s = object(value);
  for (const key of ['offset', 'next', 'produced', 'retainedFrom', 'revision']) {
    if (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0) throw protocolError(`Invalid stream ${key}`);
  }
  if (typeof s.stream !== 'string' || !['raw', 'collect'].includes(s.mode as string)
      || typeof s.data !== 'string' || typeof s.eof !== 'boolean' || typeof s.gap !== 'boolean'
      || !(s.spill === null || typeof s.spill === 'string') || !(s.error === null || typeof s.error === 'object')) {
    throw protocolError('Invalid stream snapshot');
  }
  const result = s as unknown as Snapshot;
  if (result.retainedFrom > result.offset || result.offset > result.next || result.next > result.produced
      || decodeBytes(result.data).length !== result.next - result.offset) throw protocolError('Invalid stream coordinates');
  return result;
}
