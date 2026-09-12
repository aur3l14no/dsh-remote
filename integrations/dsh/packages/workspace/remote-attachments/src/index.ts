import type { RemoteWorkspace } from '../../../world/ssh-world/src/workspace.ts';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment';
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment, SaveImageAttachment, StoredImageAttachment, ImageRequestPolicy, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
import LocalAttachmentStore, { prepareImageFile, verifyImageData, fileLeafName } from '@deepseek-ai/dsh-attachment-local';
import type { Config as LocalConfig } from '@deepseek-ai/dsh-attachment-local';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { readFile, rawStream, writeFileStream, RemoteError } from '../../../../../../runtime/client/src/index.ts';
import type { Metadata } from '../../../../../../runtime/client/src/index.ts';
import { workspaceFingerprint, type WorkspaceDefinition } from '../../../world/execution-world/src/identity.ts';
import type {} from '../../../world/execution-world/src/worlds.ts';
import type {} from '../../portable-workspace/src/registry.ts';
import { observe } from '../../../../shared/lifetime.ts';

const fingerprint = workspaceFingerprint;
const remoteId = /^sha256:([a-f0-9]{64})@world-([a-f0-9]{64})$/;
const missingSession = () => new RemoteError('WORLD_REQUIRED', 'Attachment storage requires an explicit bound Session');

/** Every IO operation requires a Session; SSH references belong to its saved workspace. */
export default class RemoteAttachments extends LocalAttachmentStore {
  static inject = ['executionWorlds', 'worldPortableWorkspaces'];
  private readonly scoped = new Map<string, SessionAttachments | LocalSessionAttachments>();
  readonly lifetime = new AbortController();
  readonly localConfig: LocalConfig;
  get host(): Context { return this.ctx; }

  constructor(ctx: Context, config: LocalConfig = {}) {
    super(ctx, config);
    this.localConfig = config;
    ctx.effect(() => () => { this.lifetime.abort(new Error('Attachment store disposed')); this.scoped.clear(); });
  }

  override forSession(sessionId: string | undefined): AttachmentStore {
    if (sessionId === undefined) return this; // Policy/pricing queries have no owner and perform no IO.
    this.lifetime.signal.throwIfAborted();
    const definition = this.ctx.executionWorlds.bindings.get(sessionId);
    if (!definition) throw missingSession();
    let scoped = this.scoped.get(sessionId);
    if (!scoped) {
      scoped = definition.kind === 'local' ? new LocalSessionAttachments(this, sessionId, definition) : new SessionAttachments(this, sessionId, definition);
      this.scoped.set(sessionId, scoped);
    }
    scoped.assertBinding();
    return scoped;
  }

  override async saveImages(_inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> { throw missingSession(); }
  override async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { throw missingSession(); }
  override async saveFile(_input: SaveFileAttachment): Promise<FileAttachmentRef> { throw missingSession(); }
  override async saveFileStream(_input: SaveFileStreamAttachment): Promise<FileAttachmentRef> { throw missingSession(); }
  override async readImage(_ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> { throw missingSession(); }
  override async *readFileStream(_ref: FileAttachmentRef, _signal?: AbortSignal): AsyncIterable<Uint8Array> { throw missingSession(); }
  override imageHostPath(_ref: ImageAttachmentRef): undefined { return undefined; }
  override fileHostPath(_ref: FileAttachmentRef): undefined { return undefined; }
  /** One global compression budget across all Sessions. No host publication. */
  prepareImage(input: SaveImageAttachment) {
    return this.compression.run(() => prepareImageFile(input, this.imageLimits, this.normalizationPolicy));
  }
}

/** Native storage mechanics and historical ids, gated by an explicit local Session binding. */
class LocalSessionAttachments extends LocalAttachmentStore {
  private readonly key: string;
  constructor(private readonly parent: RemoteAttachments, private readonly sessionId: string, definition: WorkspaceDefinition) {
    super(new Context(), parent.localConfig);
    this.key = fingerprint(definition);
  }
  assertBinding(): void {
    this.parent.lifetime.signal.throwIfAborted();
    const saved = this.parent.host.executionWorlds.bindings.get(this.sessionId);
    if (!saved || saved.kind !== 'local' || fingerprint(saved) !== this.key) throw new RemoteError('WORLD_MISMATCH', 'Local attachment Session binding is missing or changed');
  }
  override forSession(id: string | undefined): AttachmentStore { return this.parent.forSession(id); }
  override saveImages(inputs: readonly SaveImageAttachment[]) { this.assertBinding(); return super.saveImages(inputs); }
  override saveImage(input: SaveImageAttachment) { this.assertBinding(); return super.saveImage(input); }
  override saveFile(input: SaveFileAttachment) { this.assertBinding(); return super.saveFile(input); }
  override saveFileStream(input: SaveFileStreamAttachment) { this.assertBinding(); return super.saveFileStream(input); }
  override readImage(ref: ImageAttachmentRef, signal?: AbortSignal) { this.assertBinding(); return super.readImage(ref, signal); }
  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal) { this.assertBinding(); return super.readFileStream(ref, signal); }
  override readImageRequest(ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal) { this.assertBinding(); return super.readImageRequest(ref, policy, signal); }
  override imageHostPath(ref: ImageAttachmentRef) { this.assertBinding(); return super.imageHostPath(ref); }
  override fileHostPath(ref: FileAttachmentRef) { this.assertBinding(); return super.fileHostPath(ref); }
}

class SessionAttachments extends LocalAttachmentStore {
  private readonly key: string;

  constructor(private readonly parent: RemoteAttachments, private readonly sessionId: string, private readonly definition: WorkspaceDefinition) {
    // Only provider request variants may persist in this disposable host cache.
    super(new Context(), { ...parent.localConfig, dshHome: join(parent.root, '..', '..', 'remote', 'attachment-cache', fingerprint(definition)) });
    this.key = fingerprint(definition);
  }

  override forSession(sessionId: string | undefined): AttachmentStore { return this.parent.forSession(sessionId); }

  assertBinding(): void {
    this.parent.lifetime.signal.throwIfAborted();
    const saved = this.parent.host.executionWorlds.bindings.get(this.sessionId);
    if (!saved || fingerprint(saved) !== this.key) throw new RemoteError('WORLD_MISMATCH', 'Attachment Session binding is missing or changed');
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.parent.lifetime.signal]) : this.parent.lifetime.signal;
  }

  private hash(ref: ImageAttachmentRef | FileAttachmentRef): string {
    this.assertBinding();
    const match = remoteId.exec(ref.attachmentId);
    if (match?.[2] !== this.key) throw new AttachmentError('Attachment belongs to another storage World.', 'INVALID_ATTACHMENT_REF');
    if (!match || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new AttachmentError('Invalid attachment reference.', 'INVALID_ATTACHMENT_REF');
    return match[1]!;
  }

  private objectRoot(owner = this.parent.host.executionWorlds.forSession(this.sessionId)): string {
    const base = owner.remoteWorkspace.dataRoot;
    if (!base || !posix.isAbsolute(base) || posix.normalize(base) !== base) throw new RemoteError('WORLD_REQUIRED', 'Remote account data directory is unavailable');
    return posix.join(base, 'attachments', 'v1', this.key);
  }

  override imageHostPath(_ref: ImageAttachmentRef): undefined { return undefined; }
  override fileHostPath(_ref: FileAttachmentRef): undefined { return undefined; }
  override imageExecutionPath(ref: ImageAttachmentRef): string | undefined {
    const hash = this.hash(ref);
    return posix.join(this.objectRoot(), 'objects', hash.slice(0, 2), hash);
  }
  override fileExecutionPath(ref: FileAttachmentRef): string | undefined {
    const hash = this.hash(ref);
    if (ref.name !== fileLeafName(ref.name)) throw new AttachmentError('Invalid attachment filename.', 'INVALID_ATTACHMENT_REF');
    return posix.join(this.objectRoot(), 'files', hash.slice(0, 2), hash, ref.name);
  }

  private async prepare(signal: AbortSignal, writing = false): Promise<Context> {
    this.assertBinding();
    const ctx = this.parent.host;
    const workspace = await observe(ctx.worldPortableWorkspaces.contextForSession(SessionId(this.sessionId)), signal);
    if (fingerprint(ctx.worldPortableWorkspaces.definition(workspace.id)) !== this.key) throw new RemoteError('WORLD_MISMATCH', 'Attachment workspace membership differs from the binding');
    await observe(ctx.executionWorlds.prepare(this.sessionId), signal);
    this.assertBinding();
    signal.throwIfAborted();
    const owner = ctx.executionWorlds.forSession(this.sessionId);
    const root = this.objectRoot(owner);
    const target = await owner.fs.resolve(root, { signal });
    if (owner.fs.processPath(target) !== root) throw new AttachmentError('Attachment directory resolves through a symlink.', 'ATTACHMENT_READ_FAILED');
    if (writing) {
      if (!owner.remoteWorkspace.client.info.capabilities.includes('fs.sync')) throw new RemoteError('UNSUPPORTED', 'Remote attachment writes require a helper with fs.sync; update the helper');
      // An explicitly selected World executes this fixed setup command. No host shell or user command rewriting.
      const command = owner.subprocess.spawn({ argv: ['sh', '-c', 'umask 077; mkdir -p -- "$1"', 'dsh-attachments', root], cwd: this.definition.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 500, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if ((await command.done).exitCode !== 0) throw new AttachmentError('Unable to create remote attachment directory.', 'ATTACHMENT_WRITE_FAILED');
      const info = await owner.remoteWorkspace.resources.run(signal, signal => owner.remoteWorkspace.client.requestWhenReady<Metadata>('fs.stat', { path: root, follow: false }, signal));
      if (info?.kind !== 'directory' || (info.mode & 0o077) !== 0) throw new AttachmentError('Remote attachment directory must be private.', 'ATTACHMENT_WRITE_FAILED');
    }
    this.assertBinding();
    signal.throwIfAborted();
    return owner;
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.assertBinding();
    this.validateImageBatch(inputs);
    const prepared = await Promise.all(inputs.map(input => this.parent.prepareImage(input)));
    const signal = this.signal();
    const owner = await this.prepare(signal, true);
    const refs: ImageAttachmentRef[] = [];
    for (const image of prepared) {
      const ref = { ...image.ref, attachmentId: AttachmentId(`${image.ref.attachmentId}@world-${this.key}`) };
      await this.publish(owner.remoteWorkspace, this.imageExecutionPath(ref)!, ref, () => (async function* () { yield image.data; })(), signal);
      refs.push(ref);
    }
    this.assertBinding();
    return refs;
  }
  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> { return (await this.saveImages([input]))[0]!; }

  override async readImage(ref: ImageAttachmentRef, cancellation?: AbortSignal): Promise<StoredImageAttachment> {
    this.assertBinding();
    const signal = this.signal(cancellation);
    this.hash(ref);
    const owner = await this.prepare(signal);
    try {
      const read = await owner.remoteWorkspace.resources.run(signal, signal => readFile(owner.remoteWorkspace.client, this.imageExecutionPath(ref)!, ref.bytes, signal));
      await verifyImageData({ ...ref, attachmentId: AttachmentId(`sha256:${this.hash(ref)}`) }, read.data, signal);
      const result = { ref, data: read.data };
      this.assertBinding();
      return result;
    } catch (error) { this.readFailure(error, signal); }
  }
  override readImageRequest(ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal): Promise<RequestImageAttachment> {
    this.assertBinding();
    this.hash(ref);
    return super.readImageRequest(ref, policy, this.signal(signal));
  }

  override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return this.saveFileStream({ ...input, data: (async function* () { yield input.data; })() });
  }
  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    const signal = this.signal(input.signal);
    const owner = await this.prepare(signal, true);
    const limit = owner.remoteWorkspace.client.info.limits.uploadBytes!;
    // Content addressing needs a digest before the final remote name is known.
    // Spool bounded chunks temporarily, then upload with backpressure and remove the spool on every outcome.
    const staging = join(this.parent.root, '..', '..', 'remote', 'attachment-staging');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(staging, 'upload-'));
    const path = join(directory, 'data');
    try {
      const file = await open(path, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of input.data) {
          signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > limit) throw new AttachmentError(`File exceeds the remote attachment limit (${limit} bytes).`, 'ATTACHMENT_TOO_LARGE');
          hash.update(chunk);
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      signal.throwIfAborted();
      const ref: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${hash.digest('hex')}@world-${this.key}`), bytes, name: fileLeafName(input.name) };
      await this.publish(owner.remoteWorkspace, this.fileExecutionPath(ref)!, ref, () => createReadStream(path, { highWaterMark: 65536, signal }), signal);
      this.assertBinding();
      return ref;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async publish(workspace: RemoteWorkspace, path: string, ref: ImageAttachmentRef | FileAttachmentRef, source: () => AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> {
    return workspace.resources.run(signal, async signal => {
      const client = workspace.client;
      try {
        await writeFileStream(client, path, source(), ref.bytes, { kind: 'absent' }, signal);
      } catch (error) {
        if (!(error instanceof RemoteError) || error.code !== 'CREATE_CONFLICT') throw error;
        // Existing content is accepted only after a byte-count and SHA-256 check, never merely by its name.
        for await (const _chunk of this.readVerified(workspace, path, ref, signal)) { /* verify the complete existing object */ }
      }
      // Durable acknowledgement precedes the Session reference. This also covers deduplicated objects.
      await client.requestWhenReady('fs.sync', { path }, signal);
      this.assertBinding();
      signal.throwIfAborted();
    });
  }

  override async *readFileStream(ref: FileAttachmentRef, cancellation?: AbortSignal): AsyncIterable<Uint8Array> {
    this.assertBinding();
    const signal = this.signal(cancellation);
    this.hash(ref);
    const owner = await this.prepare(signal);
    try { yield* this.readVerified(owner.remoteWorkspace, this.fileExecutionPath(ref)!, ref, signal); }
    catch (error) { this.readFailure(error, signal); }
    this.assertBinding();
  }

  private async *readVerified(workspace: RemoteWorkspace, path: string, ref: ImageAttachmentRef | FileAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const client = workspace.client;
    signal = workspace.resources.signal(signal);
    const { opened, close } = await workspace.resources.run(signal, async signal => {
      const opened = await client.requestWhenReady<{ stream: string; metadata: Metadata }>('fs.read', { path, maxBytes: ref.bytes }, signal);
      const cleanup = async () => {
        if (client.state === 'ready' || client.state === 'reconnecting') await client.requestWhenReady('stream.close', { stream: opened.stream });
      };
      try { return { opened, close: workspace.registerOwner(cleanup) }; }
      catch (error) { await cleanup(); throw error; }
    });
    try {
      if (opened.metadata.size !== ref.bytes) throw new AttachmentError('Attachment size has changed.', 'ATTACHMENT_CORRUPT');
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of rawStream(client, opened.stream, signal)) {
        bytes += chunk.byteLength;
        if (bytes > ref.bytes) throw new AttachmentError('Attachment grew while being read.', 'ATTACHMENT_CORRUPT');
        hash.update(chunk);
        yield chunk;
      }
      if (bytes !== ref.bytes || hash.digest('hex') !== this.hash(ref)) throw new AttachmentError('Attachment failed integrity verification.', 'ATTACHMENT_CORRUPT');
    } finally { await close(); }
  }

  private readFailure(error: unknown, signal: AbortSignal): never {
    signal.throwIfAborted();
    if (error instanceof RemoteError && error.code === 'NOT_FOUND') throw new AttachmentError('Remote attachment is missing.', 'ATTACHMENT_NOT_FOUND');
    throw error;
  }
}
