import fs from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';

const identifier = z.string().min(1).max(512).regex(/^[^\0\r\n]+$/);
const path = identifier.refine(value => value.startsWith('/'), 'Absolute path required');
const sshWorldSchema = z.object({
  id: identifier, kind: z.literal('ssh'), host: identifier.refine(value => !value.startsWith('-')),
  cwd: path, configFile: path.optional(), installRoot: path.optional(), runtimeBase: path.optional(),
  podmanContainer: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const localWorldSchema = z.object({ id: identifier, kind: z.literal('local'), cwd: path }).strict();
const worldSchema = z.discriminatedUnion('kind', [sshWorldSchema, localWorldSchema]);
const documentSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), worlds: z.array(worldSchema),
  sessions: z.array(z.object({ sessionId: identifier, worldId: identifier }).strict()),
}).strict();
export type SshWorldDefinition = Readonly<z.infer<typeof sshWorldSchema>>;
export type LocalWorldDefinition = Readonly<z.infer<typeof localWorldSchema>>;
export type WorldDefinition = SshWorldDefinition | LocalWorldDefinition;
export type WorldTarget = Omit<SshWorldDefinition, 'id' | 'cwd'> | { kind: 'local' };
type Document = z.infer<typeof documentSchema>;
const MAX_BYTES = 4 * 1024 * 1024;

export function worldDefinition(input: unknown): WorldDefinition {
  const result = worldSchema.safeParse(input);
  if (!result.success) throw new RemoteError('INVALID_WORLD', 'Invalid execution World definition');
  return Object.freeze(result.data);
}

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
        BindingStore.publish(file, { version: 1, worlds: [], sessions: [] });
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
    if (document.version === 1 && document.worlds.some(world => world.kind !== 'ssh')) {
      throw new RemoteError('INVALID_BINDINGS', 'Version 1 bindings support SSH Worlds only');
    }
    const worlds = new Set(document.worlds.map(world => world.id));
    const sessions = new Set(document.sessions.map(binding => binding.sessionId));
    if (worlds.size !== document.worlds.length || sessions.size !== document.sessions.length
        || document.sessions.some(binding => !worlds.has(binding.worldId))) {
      throw new RemoteError('INVALID_BINDINGS', 'Duplicate or dangling binding identity');
    }
    return document;
  }

  get(sessionId: string): WorldDefinition | undefined {
    const document = this.read();
    const binding = document.sessions.find(entry => entry.sessionId === sessionId);
    return binding && Object.freeze(document.worlds.find(world => world.id === binding.worldId)!);
  }

  private check(document: Document, sessionId: string, world: WorldDefinition): boolean {
    if (!identifier.safeParse(sessionId).success) throw new RemoteError('INVALID_ARGUMENT', 'Invalid Session identity');
    const existing = document.worlds.find(entry => entry.id === world.id);
    const binding = document.sessions.find(entry => entry.sessionId === sessionId);
    if ((existing && JSON.stringify(existing) !== JSON.stringify(world)) || (binding && binding.worldId !== world.id)) {
      throw new RemoteError('WORLD_MISMATCH', 'Session or World identity is already bound to another definition');
    }
    return binding !== undefined;
  }

  /** Check before provisioning, then bind rechecks under the publication lock. */
  assertCompatible(sessionId: string, input: WorldDefinition): void {
    this.check(this.read(), sessionId, worldDefinition(input));
  }

  bind(sessionId: string, input: WorldDefinition): void {
    const world = worldDefinition(input);
    BindingStore.withLock(this.file, () => {
      const document = this.read();
      if (this.check(document, sessionId, world)) return;
      if (world.kind === 'local' && document.version === 1) {
        // Preserve the exact validated generation before the first schema upgrade.
        const bytes = fs.readFileSync(this.file);
        const backup = `${this.file}.v1-${createHash('sha256').update(bytes).digest('hex')}.bak`;
        try {
          const fd = fs.openSync(backup, 'wx', 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const fd = fs.openSync(backup, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const info = fs.fstatSync(fd);
            if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || !fs.readFileSync(fd).equals(bytes)) {
              throw new RemoteError('UNSAFE_BINDINGS', 'Existing migration backup is not the validated v1 generation');
            }
          } finally { fs.closeSync(fd); }
        }
        document.version = 2;
      }
      if (!document.worlds.some(entry => entry.id === world.id)) document.worlds.push({ ...world });
      document.sessions.push({ sessionId, worldId: world.id });
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
