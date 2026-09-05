import { Context } from '@deepseek-ai/cordis';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { adoptSessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import SessionPersistence, { assertContiguous, assertStoredId, assertVersion, materializeAppendBatch, materializeCreateHeader,
  validateStoredEvents, SessionPersistenceRevision, SessionAlreadyExistsError, SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError, SessionFormatUnsupportedError, SessionHandleClosedError, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence';
import type { SessionHandle, SessionAccess, SessionPersistenceCreateOptions, SessionPersistenceOpenOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';

const FORMAT = 'dsh-ssh-world-session/1';
const MAX_BYTES = 64 * 1024 * 1024;
const WORLD_EVENTS = new Set(['execution-world/bound', 'execution-world/handoff']);
interface Stored { header: SessionHeader; inherited: number; generation: string }

function validate(header: SessionHeader, events: readonly SessionEvent[]): SessionEvent[] {
  return events.map(event => {
    // Required extension records remain required on disk. Other unknown vocabularies still fail closed.
    if (!WORLD_EVENTS.has(event.type)) return validateStoredEvents(header, [event])[0]!;
    const adopted = adoptSessionEvent(event);
    const data = adopted.data;
    if (adopted.type === 'execution-world/bound') {
      const b = adopted.data;
      if (b.schema !== 1 || typeof b.session !== 'string' || !b.world || typeof b.world.id !== 'string' || typeof b.world.target !== 'string' || typeof b.world.cwd !== 'string' || typeof b.runtime !== 'string' || typeof b.helperBuild !== 'string' || typeof b.platform !== 'string' || typeof b.arch !== 'string' || !Array.isArray(b.capabilities) || !b.capabilities.every(value => typeof value === 'string')) throw new SessionFormatUnsupportedError('Unsupported required World binding');
    } else if (adopted.type === 'execution-world/handoff' && (typeof adopted.data.sourceSession !== 'string' || typeof adopted.data.sourceWorld !== 'string')) throw new SessionFormatUnsupportedError('Unsupported World handoff record');
    if (!data || adopted.ignorable) throw new SessionFormatUnsupportedError('World ownership records must be required');
    return adopted;
  });
}

function metadata(db: DatabaseSync, id?: SessionId): Stored {
  const row = db.prepare('SELECT format, header, inherited, generation FROM metadata').get() as { format: string; header: string; inherited: number; generation: string } | undefined;
  if (!row || row.format !== FORMAT || typeof row.generation !== 'string') throw new SessionFormatUnsupportedError('World Session backend format is unsupported');
  const header = materializeCreateHeader(JSON.parse(row.header));
  assertVersion(header);
  if (id !== undefined) assertStoredId(id, header);
  if (!Number.isSafeInteger(row.inherited) || row.inherited < 0 || (!header.isSeeded && row.inherited !== 0)) throw new SessionFormatUnsupportedError('Invalid World Session inherited boundary');
  return { header, inherited: row.inherited, generation: row.generation };
}

/** Local persistence seam for required external World records, using its own explicit storage format. */
export default class WorldSessionPersistence extends SessionPersistence {
  private root: string;
  private ready: Promise<unknown>;
  private handles = new Set<StoredHandle>();
  private writers = new Map<SessionId, StoredHandle>();
  private closing = false;
  constructor(ctx: Context, config: { root: string }) {
    super(ctx);
    if (!config.root || !config.root.startsWith('/')) throw new Error('World Session storage requires an explicit absolute local root');
    this.root = resolve(config.root);
    this.ready = mkdir(this.root, { recursive: true, mode: 0o700 });
    ctx.on('session/event', (session, event) => {
      this.writers.get(session.id)?.record(event, error => ctx.logger.warn(`World Session persistence failed: ${String(error)}`));
    });
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush());
    ctx.effect(() => async () => {
      this.closing = true;
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Local Session close failed');
    });
  }
  private path(id: SessionId): string {
    return join(this.root, createHash('sha256').update(id).digest('hex') + '.world.sqlite');
  }
  private async check(signal?: AbortSignal) {
    await this.ready;
    signal?.throwIfAborted();
    if (this.closing) throw new Error('World Session persistence is closing');
  }
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    const snapshot = materializeCreateHeader(header);
    assertVersion(snapshot);
    const inherited = options?.inheritedEventCount ?? 0;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || (snapshot.isSeeded ? options?.inheritedEventCount === undefined : inherited !== 0)) throw new Error('Invalid Session inherited boundary');
    return this.acquire(snapshot.id, 'write', options?.signal, { header: snapshot, inherited });
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.acquire(id, access, options?.signal);
  }
  private async acquire(id: SessionId, access: SessionAccess, signal?: AbortSignal, initial?: Omit<Stored, 'generation'>): Promise<SessionHandle> {
    await this.check(signal);
    const path = this.path(id);
    let lock: DatabaseSync | undefined, db: DatabaseSync | undefined;
    let created = false;
    try {
      if (initial) {
        try { const file = await open(path, 'r'); await file.close(); throw new SessionAlreadyExistsError(id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (access === 'write') {
        const lockPath = path + '.lease';
        try { const file = await open(lockPath, 'wx', 0o600); await file.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await this.check(signal);
        lock = new DatabaseSync(lockPath);
        try { lock.exec('BEGIN EXCLUSIVE'); }
        catch { throw new SessionAlreadyOwnedError(id); }
      }
      if (initial) {
        try { const file = await open(path, 'wx', 0o600); created = true; await file.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionAlreadyExistsError(id); throw error; }
      }
      await this.check(signal);
      // readOnly never creates an absent database; write-open also checks existence first.
      try { const file = await open(path, 'r'); await file.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionPersistenceNotFoundError(id); throw error; }
      await this.check(signal);
      db = new DatabaseSync(path, { readOnly: access === 'read' });
      if (access === 'write') db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      if (initial) {
        db.exec('BEGIN; CREATE TABLE metadata (format TEXT, header TEXT, inherited INTEGER, generation TEXT); CREATE TABLE events (seq INTEGER PRIMARY KEY, record TEXT NOT NULL);');
        db.prepare('INSERT INTO metadata VALUES (?, ?, ?, ?)').run(FORMAT, JSON.stringify(initial.header), initial.inherited, randomUUID());
        db.exec('COMMIT');
      }
      const stored = metadata(db, id);
      signal?.throwIfAborted();
      if (this.closing) throw new Error('World Session persistence is closing');
      const handle = new StoredHandle(id, access, stored, db, lock, () => {
        this.handles.delete(handle);
        if (this.writers.get(id) === handle) this.writers.delete(id);
      });
      this.handles.add(handle);
      if (access === 'write') this.writers.set(id, handle);
      return handle;
    } catch (error) {
      try { db?.close(); if (created) await rm(path, { force: true }); }
      finally { lock?.close(); }
      throw error;
    }
  }
  async flush(): Promise<void> {
    await this.check();
    const results = await Promise.allSettled([...this.handles].filter(h => h.access === 'write').map(h => h.flush()));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Session flush failed');
  }
  async stat(id: SessionId, options?: SessionPersistenceOpenOptions): Promise<SessionPersistenceSnapshot | undefined> {
    await this.check(options?.signal);
    let handle: SessionHandle;
    try { handle = await this.open(id, 'read', options); }
    catch (error) { if (error instanceof SessionPersistenceNotFoundError) return undefined; throw error; }
    try { return (handle as StoredHandle).snapshot(); } finally { await handle.close(); }
  }
  async list(options?: SessionPersistenceOpenOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    await this.check(options?.signal);
    const result: SessionPersistenceSnapshot[] = [];
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.world\.sqlite$/.test(file)) continue;
      await this.check(options?.signal);
      const db = new DatabaseSync(join(this.root, file), { readOnly: true });
      try {
        const stored = metadata(db);
        const snapshot = await this.stat(stored.header.id, options);
        if (snapshot) result.push(snapshot);
      } finally { db.close(); }
    }
    return result;
  }
}

class StoredHandle implements SessionHandle {
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  private closed = false;
  private generation: string;
  private failure: unknown;
  private closePromise?: Promise<void>;
  constructor(readonly id: SessionId, readonly access: SessionAccess, stored: Stored, private db: DatabaseSync,
    private lock: DatabaseSync | undefined, private forget: () => void) {
    this.header = Object.freeze(stored.header);
    this.inheritedEventCount = SessionLogOffset(stored.inherited);
    this.generation = stored.generation;
  }
  private check(operation: string, signal?: AbortSignal, write = false) {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation);
    if (this.failure !== undefined) throw this.failure;
    signal?.throwIfAborted();
    if (write && this.access !== 'write') throw new SessionReadOnlyError(this.id, operation);
  }
  snapshot(): SessionPersistenceSnapshot {
    const row = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(record AS BLOB))), 0) AS bytes FROM events').get() as { n: number; bytes: number };
    return { header: this.header, eventCount: row.n, revision: SessionPersistenceRevision(JSON.stringify([this.generation, row.n])), sizeBytes: row.bytes };
  }
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: { signal?: AbortSignal }): Promise<readonly SessionEvent[]> {
    this.check('read', options?.signal);
    if (this.snapshot().sizeBytes! > MAX_BYTES) throw new Error('Stored World Session exceeds the 64 MiB limit');
    if (![offset, length].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid Session read range');
    const rows = this.db.prepare('SELECT record FROM events WHERE seq >= ? ORDER BY seq LIMIT ?').all(offset, length) as { record: string }[];
    const events = validate(this.header, rows.map(row => JSON.parse(row.record)));
    assertContiguous(this.id, events, offset);
    return events;
  }
  async append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void> {
    this.check('append', options?.signal, true);
    this.appendNow(events);
  }
  /** Synchronous, bounded live route: checkpoint/close report a sticky storage failure. */
  record(event: SessionEvent, report: (error: unknown) => void): void {
    if (this.failure !== undefined) return;
    try { this.check('record', undefined, true); this.appendNow([event]); }
    catch (error) { this.failure = error; report(error); }
  }
  private appendNow(events: readonly SessionEvent[]): void {
    const batch = validate(this.header, materializeAppendBatch(events));
    const current = this.snapshot();
    assertContiguous(this.id, batch, current.eventCount!);
    const records = batch.map(event => JSON.stringify(event));
    if (current.sizeBytes! + records.reduce((n, s) => n + Buffer.byteLength(s), 0) > MAX_BYTES) throw new Error('World Session exceeds the 64 MiB experimental storage limit');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT INTO events VALUES (?, ?)');
      records.forEach((record, i) => insert.run(batch[i]!.seq, record));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async flush(options?: { signal?: AbortSignal }): Promise<void> {
    this.check('flush', options?.signal, true);
    // Every append already commits with SQLite synchronous=FULL.
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    return this.closePromise = (async () => {
      try { this.db.close(); }
      finally { try { this.lock?.close(); } finally { this.forget(); } }
      if (this.failure !== undefined) throw this.failure;
    })();
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
