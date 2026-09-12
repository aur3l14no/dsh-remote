import { Context } from '@deepseek-ai/cordis';
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs';
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome, FsErrorCode } from '@deepseek-ai/dsh-fs';
import { posix } from 'node:path';
import { readFile, readFileRange, writeFile, rawStream, RemoteError } from '../../../../../../runtime/client/src/index.ts';
import type { Metadata, Expected } from '../../../../../../runtime/client/src/index.ts';
import type { RemoteWorkspace } from './workspace.ts';
import { fileAuthorization } from './file-authorization.ts';

export interface Config { textMaxBytes: number; diffBasisMaxBytes: number }
const normalize = (text: string) => text.replaceAll('\r\n', '\n');
function text(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new FsError('File contains NUL bytes', 'FS_NOT_TEXT');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (cause) { throw new FsError('File is not valid UTF-8', 'FS_NOT_TEXT', { cause }); }
}
function translate(error: unknown): never {
  if (error instanceof RemoteError) {
    const codes: Record<string, FsErrorCode> = {
      NOT_FOUND: 'FS_NOT_FOUND', NOT_DIRECTORY: 'FS_NOT_DIRECTORY', NOT_REGULAR_FILE: 'FS_NOT_REGULAR_FILE',
      PERMISSION_DENIED: 'FS_PERMISSION_DENIED', STALE_VERSION: 'FS_STALE_VERSION', CREATE_CONFLICT: 'FS_NOT_OBSERVED',
      TOO_LARGE: 'FS_TOO_LARGE', RESOURCE_LIMIT: 'FS_TOO_LARGE', CLIENT_RESOURCE_LIMIT: 'FS_TOO_LARGE', CANCELLED: 'FS_ABORTED',
    };
    throw new FsError(error.message, codes[error.code] ?? 'FS_IO_ERROR', { cause: error });
  }
  throw error;
}

export default class SshFileSystem extends FileSystem {
  static inject = ['remoteWorkspace'];
  private config: Config;
  private readonly workspace: RemoteWorkspace;
  private locks = new Map<string, Promise<unknown>>();
  constructor(ctx: Context, config: Config) {
    super(ctx); this.config = config; this.workspace = ctx.remoteWorkspace;
    for (const n of [config.textMaxBytes, config.diffBasisMaxBytes]) if (!Number.isSafeInteger(n) || n < 1 || n > 64 * 1024 * 1024) throw new Error('Unsupported filesystem text budget');
  }
  get client() { return this.workspace.client; }
  private target(path: string): FsTarget {
    return { targetKey: FsTargetKey(JSON.stringify([this.client.info.world, this.client.info.runtime, path])), displayPath: path };
  }
  processPath(target: FsTarget): string {
    const [world, runtime, path] = JSON.parse(target.targetKey) as [string, string, string];
    if (world !== this.client.info.world || runtime !== this.client.info.runtime || !path.startsWith('/')) throw new FsError('Target belongs to a different World or runtime epoch', 'FS_IO_ERROR');
    return path;
  }
  fileUrl(target: FsTarget): string { return `file://${this.processPath(target).split('/').map(encodeURIComponent).join('/')}`; }
  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = this.processPath(parent);
    let identity: unknown;
    try { identity = JSON.parse(child.targetKey); } catch { return false; }
    if (!Array.isArray(identity) || identity[0] !== this.client.info.world || identity[1] !== this.client.info.runtime) return false;
    const relative = posix.relative(parentPath, this.processPath(child));
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative));
  }
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.workspace.resources.run(opts?.signal, async signal => {
      opts = { ...opts, signal };
      try {
        if (!path.trim()) throw new FsError('Path must not be empty', 'FS_NOT_FOUND');
        const result = await this.client.requestWhenReady<{ path: string }>('fs.resolve', { path, cwd: opts?.cwd ?? this.workspace.cwd }, opts?.signal);
        return this.target(result.path);
      } catch (error) { translate(error); }
    });
  }
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.workspace.resources.run(signal, async signal => {
      try {
        const m = await this.client.requestWhenReady<Metadata | null>('fs.stat', { path: this.processPath(target) }, signal);
        return m ? { version: FsVersion(m.version), type: m.kind === 'symlink' ? 'other' : m.kind, size: m.size } : undefined;
      } catch (error) { translate(error); }
    });
  }
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.workspace.resources.run(signal, async signal => {
      try {
        const m = await this.client.requestWhenReady<Metadata | null>('fs.stat', { path: posix.resolve(opts?.cwd ?? this.workspace.cwd, path), follow: false }, signal);
        return m ? { version: FsVersion(m.version), type: m.kind, size: m.size } : undefined;
      } catch (error) { translate(error); }
    });
  }
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.workspace.resources.run(signal, async signal => {
      try { return (await readFile(this.client, this.processPath(target), maxBytes, signal)).data; }
      catch (error) { translate(error); }
    });
  }
  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return this.workspace.resources.run(signal, async signal => {
      try { return (await readFileRange(this.client, this.processPath(target), range.offset, range.length, signal)).data; }
      catch (error) { translate(error); }
    });
  }
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> { return text(await this.readBytes(target, signal, this.config.textMaxBytes)); }
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.workspace.resources.run(signal, async signal => {
      signal = this.workspace.resources.signal(signal);
      const client = this.client;
      let opened: { stream: string };
      try { opened = await client.requestWhenReady('fs.read', { path: this.processPath(target), maxBytes: this.config.textMaxBytes }, signal); }
      catch (error) { translate(error); }
      const cleanup = async () => {
        if (client.state === 'ready' || client.state === 'reconnecting') {
          await client.requestWhenReady('stream.close', { stream: opened.stream });
        }
      };
      let close: () => Promise<void>;
      try { close = this.workspace.registerOwner(cleanup); }
      catch (error) { await cleanup(); throw error; }
      return (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          for await (const bytes of rawStream(client, opened.stream, signal)) {
            if (bytes.includes(0)) throw new FsError('File contains NUL bytes', 'FS_NOT_TEXT');
            try { yield decoder.decode(bytes, { stream: true }); }
            catch (cause) { throw new FsError('File is not valid UTF-8', 'FS_NOT_TEXT', { cause }); }
          }
          try { const tail = decoder.decode(); if (tail) yield tail; }
          catch (cause) { throw new FsError('File ends with incomplete UTF-8', 'FS_NOT_TEXT', { cause }); }
        } catch (error) { translate(error); }
        finally {
          await close();
        }
      })();
    });
  }
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.workspace.resources.run(signal, async signal => {
      try {
        const result = await this.client.requestWhenReady<{ entries: { name: string; path: string; metadata: Metadata | null }[] }>('fs.list', { path: this.processPath(target) }, signal);
        return result.entries.map(e => ({ name: e.name, target: this.target(e.path), type: e.metadata?.kind === 'file' ? 'file' : e.metadata?.kind === 'directory' ? 'directory' : 'other',
          ...(e.metadata ? { version: FsVersion(e.metadata.version), size: e.metadata.size } : {}) }));
      } catch (error) { translate(error); }
    });
  }
  private async locked<T>(target: FsTarget, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(target.targetKey) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.locks.set(target.targetKey, current);
    try { return await current; } catch (error) { return translate(error); }
    finally { if (this.locks.get(target.targetKey) === current) this.locks.delete(target.targetKey); }
  }
  private async publish(target: FsTarget, content: string, expected: Expected, signal?: AbortSignal): Promise<{ version: FsVersion; operation: 'create' | 'update' }> {
    const authorization = fileAuthorization.getStore();
    if (authorization && authorization.owner !== this.workspace.resources) throw new FsError('File authorization belongs to another workspace owner', 'FS_PERMISSION_DENIED');
    const result = await writeFile(this.client, this.processPath(target), Buffer.from(content), expected, signal, authorization?.root);
    if (!result.metadata) throw new FsError('File was committed but its new version could not be observed; do not automatically repeat the write', 'FS_IO_ERROR', { cause: new RemoteError('COMMITTED_UNOBSERVED', 'Publication succeeded', { committed: true }) });
    return { version: FsVersion(result.metadata.version), operation: result.kind };
  }
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.workspace.resources.run(signal, async signal => {
      return this.locked(target, async () => {
        let before: string | null = null;
        if (expected?.kind !== 'createIfAbsent' && Buffer.byteLength(content) < this.config.diffBasisMaxBytes) {
          try {
            const prior = await readFile(this.client, this.processPath(target), this.config.diffBasisMaxBytes - 1, signal);
            if (prior.data.length === prior.metadata.size) before = normalize(text(prior.data));
          } catch (error) {
            if (signal?.aborted) throw new RemoteError('CANCELLED', 'Write aborted');
            // Context is optional; infrastructure loss still fails the actual remote publication.
            if (!(error instanceof FsError || error instanceof RemoteError)) throw error;
          }
        }
        const guard: Expected = expected?.kind === 'createIfAbsent' ? { kind: 'absent' } : expected ? { kind: 'version', version: expected.version } : { kind: 'any' };
        const result = await this.publish(target, content, guard, signal);
        return { ...result, before: result.operation === 'create' ? null : before, after: normalize(content) };
      });
    });
  }
  editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.workspace.resources.run(signal, async signal => {
      return this.locked(target, async () => {
        const observed = await this.stat(target, signal);
        if (expected && observed?.version !== expected.version) throw new FsError('File changed since observation', 'FS_STALE_VERSION');
        if (!observed) throw new FsError('File does not exist', 'FS_NOT_FOUND');
        const read = await readFile(this.client, this.processPath(target), this.config.textMaxBytes, signal);
        if (read.metadata.version !== observed.version) throw new FsError('File changed before editing', 'FS_STALE_VERSION');
        const raw = text(read.data), before = normalize(raw), old = normalize(edit.oldString), replacement = normalize(edit.newString);
        if (!old) throw new FsError('old_string must be non-empty', 'FS_EDIT_NOT_FOUND');
        const parts = before.split(old);
        if (parts.length === 1) throw new FsError('old_string was not found', 'FS_EDIT_NOT_FOUND');
        if (parts.length > 2 && !edit.replaceAll) throw new FsError('old_string matched more than once', 'FS_AMBIGUOUS_EDIT');
        const after = parts.join(replacement);
        const sample = raw.slice(0, 4096), crlf = sample.split('\r\n').length - 1, lf = sample.split('\n').length - 1 - crlf;
        const stored = crlf > lf ? after.replaceAll('\n', '\r\n') : after;
        const result = await this.publish(target, stored, { kind: 'version', version: observed.version }, signal);
        return { version: result.version, before, after };
      });
    });
  }
}
