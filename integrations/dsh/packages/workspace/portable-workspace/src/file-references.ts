import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import FileReferenceService, { FILE_REFERENCE_PROMPT, type FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference';
import { DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES } from '@deepseek-ai/dsh-file-reference-local';
import { posix } from 'node:path';
import type {} from '../../../world/ssh-world/src/worlds.ts';

/** Path-only discovery; contents remain behind the normal remote read tool. */
export default class RemoteFileReferences extends FileReferenceService {
  static inject = ['executionWorlds', 'systemPrompt'];
  constructor(ctx: Context) {
    super(ctx);
    ctx.systemPrompt.context({ name: 'remote-file-references', order: 100, text: () => FILE_REFERENCE_PROMPT });
  }
  async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const owner = this.ctx.executionWorlds.forAgent(agent);
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('File references require a bound workspace');
    const root = await owner.fs.resolve(cwd, { signal });
    const rootPath = owner.fs.processPath(root);
    const pending = [root];
    const visited = new Set<string>();
    const candidates = new Map<string, FileReferenceCandidate>();
    const excluded = new Set<string>(DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES);
    let entries = 0;
    while (pending.length) {
      signal.throwIfAborted();
      const directory = pending.pop()!;
      const directoryPath = owner.fs.processPath(directory);
      if (visited.has(directoryPath)) continue;
      visited.add(directoryPath);
      for (const entry of await owner.fs.listDir(directory, signal)) {
        if (++entries > 50000) throw new Error('File reference discovery exceeds 50000 entries; narrow the workspace');
        if (excluded.has(entry.name) || !owner.fs.contains(root, entry.target)) continue;
        const path = posix.relative(rootPath, owner.fs.processPath(entry.target));
        if (!path || (entry.type !== 'file' && entry.type !== 'directory')) continue;
        candidates.set(path, { path, kind: entry.type });
        if (entry.type === 'directory') pending.push(entry.target);
      }
    }
    const needle = query.trim().replace(/^\.\//, '').toLowerCase();
    return [...candidates.values()].filter(row => row.path.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.path.toLowerCase().startsWith(needle)) - Number(a.path.toLowerCase().startsWith(needle)) || a.path.localeCompare(b.path))
      .slice(0, 20);
  }
}
