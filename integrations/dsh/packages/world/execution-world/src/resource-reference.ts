import { Context } from '@deepseek-ai/cordis';
import { FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs';
import { worldFingerprint, type WorkspaceDefinition } from './identity.ts';

/** A durable file address carries execution identity independently of its viewing Session. */
export function fileReference(definition: WorkspaceDefinition, cwd: string, path: string): string {
  const url = new URL(`world://${encodeURIComponent(definition.worldId)}/`);
  url.pathname = path.split('/').map(encodeURIComponent).join('/');
  url.searchParams.set('root', cwd);
  const { id: _id, worldId, cwd: _cwd, ...environment } = definition;
  url.searchParams.set('environment', worldFingerprint({ ...environment, id: worldId }));
  return url.href;
}
export function parseReference(path: string) {
  if (!path.startsWith('world:')) return undefined;
  const url = new URL(path);
  if (url.protocol !== 'world:' || url.username || url.password || url.port || url.hash) throw new Error('Invalid World file reference');
  const world = decodeURIComponent(url.hostname);
  const cwd = url.searchParams.get('root');
  const fingerprint = url.searchParams.get('environment');
  if (!world || !cwd?.startsWith('/') || !fingerprint) throw new Error('Incomplete World file reference');
  return { world, cwd, fingerprint, path: decodeURIComponent(url.pathname) };
}

/** Read-only view that preserves qualified addresses through file-preview round trips. */
export class ReferencedFiles extends FileSystem {
  constructor(private readonly fs: FileSystem, private readonly definition: WorkspaceDefinition, private readonly cwd: string) { super(new Context()); }
  private path(value: string): string {
    const ref = parseReference(value);
    if (!ref) return value;
    if (fileReference(this.definition, ref.cwd, ref.path) !== value || ref.cwd !== this.cwd) throw new Error('File reference changed execution environment');
    return ref.path;
  }
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) { return this.fs.resolve(this.path(path), { ...opts, cwd: opts?.cwd ?? this.cwd }); }
  processPath(target: FsTarget) { return fileReference(this.definition, this.cwd, this.fs.processPath(target)); }
  fileUrl(target: FsTarget) { return this.processPath(target); }
  contains(...args: Parameters<FileSystem['contains']>) { return this.fs.contains(...args); }
  stat(...args: Parameters<FileSystem['stat']>) { return this.fs.stat(...args); }
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) { return this.fs.lstat(this.path(path), { cwd: opts?.cwd ?? this.cwd }, signal); }
  readText(...args: Parameters<FileSystem['readText']>) { return this.fs.readText(...args); }
  streamText(...args: Parameters<FileSystem['streamText']>) { return this.fs.streamText(...args); }
  readBytes(...args: Parameters<FileSystem['readBytes']>) { return this.fs.readBytes(...args); }
  readByteRange(...args: Parameters<FileSystem['readByteRange']>) { return this.fs.readByteRange(...args); }
  listDir(...args: Parameters<FileSystem['listDir']>) { return this.fs.listDir(...args); }
  async writeText(): Promise<never> { throw new Error('File-preview references are read-only'); }
  async editText(): Promise<never> { throw new Error('File-preview references are read-only'); }
}
