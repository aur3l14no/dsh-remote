import fs from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import { workspaceSchema, workspaceDefinition, sameWorkspace, targetFingerprint, type WorkspaceDefinition } from './identity.ts';

const identifier = z.string().min(1).max(512).regex(/^[^\0\r\n]+$/);
const documentSchema = z.object({
  version: z.literal(3), workspaces: z.array(workspaceSchema),
  sessions: z.array(z.object({ sessionId: identifier, workspaceId: identifier }).strict()),
}).strict();
type Document = z.infer<typeof documentSchema>;
const MAX_BYTES = 4 * 1024 * 1024;

/** A local sidecar, independent of DSH's Session history. Writes are synchronous publication barriers. */
export class BindingStore {
  private uncertain = false;
  readonly file: string;
  constructor(file: string) {
    if (!isAbsolute(file)) throw new RemoteError('INVALID_ARGUMENT', 'Binding store requires an absolute local path');
    this.file = file;
    this.read();
  }

  /** Explicit initialization only. Ordinary open never recreates a missing mapping. */
  static create(file: string): BindingStore {
    if (!isAbsolute(file)) throw new RemoteError('INVALID_ARGUMENT', 'Binding store requires an absolute local path');
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    BindingStore.withLock(file, () => {
      try { fs.lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        BindingStore.publish(file, { version: 3, workspaces: [], sessions: [] });
      }
    });
    return new BindingStore(file);
  }

  private static privateDirectory(file: string): void {
    const info = fs.lstatSync(dirname(file));
    if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) {
      throw new RemoteError('UNSAFE_BINDINGS', 'Binding directory must be private and owned by this account');
    }
  }

  private read(): Document {
    if (this.uncertain) throw new RemoteError('BINDING_COMMIT_UNKNOWN', 'Reopen the store after an uncertain publication');
    BindingStore.privateDirectory(this.file);
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RemoteError('BINDINGS_MISSING', 'Binding store is missing; it was not recreated');
      throw error;
    }
    let value: unknown;
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) {
        throw new RemoteError('UNSAFE_BINDINGS', 'Binding file must be a private regular file within the size limit');
      }
      // Atomic writers replace the inode, so this descriptor reads one complete generation.
      try { value = JSON.parse(fs.readFileSync(fd, 'utf8')); }
      catch { throw new RemoteError('INVALID_BINDINGS', 'Binding store contains invalid JSON'); }
    } finally { fs.closeSync(fd); }
    const parsed = documentSchema.safeParse(value);
    if (!parsed.success) throw new RemoteError('INVALID_BINDINGS', 'Unsupported or malformed binding store');
    const document = parsed.data;
    const workspaces = new Set(document.workspaces.map(workspace => workspace.id));
    const sessions = new Set(document.sessions.map(binding => binding.sessionId));
    if (workspaces.size !== document.workspaces.length || sessions.size !== document.sessions.length
        || document.sessions.some(binding => !workspaces.has(binding.workspaceId))) {
      throw new RemoteError('INVALID_BINDINGS', 'Duplicate or dangling binding identity');
    }
    const targets = new Map<string, string>();
    for (const workspace of document.workspaces) {
      const target = targetFingerprint(workspace);
      const previous = targets.get(workspace.worldId);
      if (previous !== undefined && previous !== target) throw new RemoteError('INVALID_BINDINGS', 'World identity has conflicting execution targets');
      targets.set(workspace.worldId, target);
    }
    return document;
  }

  get(sessionId: string): WorkspaceDefinition | undefined {
    const document = this.read();
    const binding = document.sessions.find(entry => entry.sessionId === sessionId);
    return binding && Object.freeze(document.workspaces.find(workspace => workspace.id === binding.workspaceId)!);
  }

  private check(document: Document, sessionId: string, workspace: WorkspaceDefinition): boolean {
    if (!identifier.safeParse(sessionId).success) throw new RemoteError('INVALID_ARGUMENT', 'Invalid Session identity');
    const environment = document.workspaces.find(entry => entry.worldId === workspace.worldId);
    if (environment && targetFingerprint(environment) !== targetFingerprint(workspace)) {
      throw new RemoteError('WORLD_MISMATCH', 'World identity is already bound to another execution target');
    }
    const existing = document.workspaces.find(entry => entry.id === workspace.id);
    const binding = document.sessions.find(entry => entry.sessionId === sessionId);
    if ((existing && !sameWorkspace(existing, workspace)) || (binding && binding.workspaceId !== workspace.id)) {
      throw new RemoteError('WORLD_MISMATCH', 'Session or workspace identity is already bound to another definition');
    }
    return binding !== undefined;
  }

  /** Check before provisioning, then bind rechecks under the publication lock. */
  assertCompatible(sessionId: string, input: WorkspaceDefinition): void {
    this.check(this.read(), sessionId, workspaceDefinition(input));
  }

  bind(sessionId: string, input: WorkspaceDefinition): void {
    const workspace = workspaceDefinition(input);
    BindingStore.withLock(this.file, () => {
      const document = this.read();
      if (this.check(document, sessionId, workspace)) return;
      if (!document.workspaces.some(entry => entry.id === workspace.id)) document.workspaces.push({ ...workspace });
      document.sessions.push({ sessionId, workspaceId: workspace.id });
      try { BindingStore.publish(this.file, document); }
      catch (error) {
        if (error instanceof RemoteError && error.code === 'BINDING_COMMIT_UNKNOWN') this.uncertain = true;
        throw error;
      }
    });
  }

  private static withLock<T>(file: string, action: () => T): T {
    BindingStore.privateDirectory(file);
    const lock = `${file}.lock`;
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RemoteError('BINDINGS_BUSY', 'Another writer or an interrupted write holds the binding lock');
      throw error;
    }
    try { return action(); }
    finally { fs.rmdirSync(lock); }
  }

  private static publish(file: string, document: Document): void {
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    if (bytes.length > MAX_BYTES) throw new RemoteError('BINDINGS_FULL', 'Binding store exceeds 4 MiB');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file); renamed = true;
      const directory = fs.openSync(dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); }
      finally { fs.closeSync(directory); }
    } catch (error) {
      if (renamed) throw new RemoteError('BINDING_COMMIT_UNKNOWN', 'Binding rename succeeded but durability was not confirmed');
      throw error;
    } finally {
      if (!renamed) fs.rmSync(temporary, { force: true });
    }
  }
}
