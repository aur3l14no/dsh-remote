import ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRestriction } from '@deepseek-ai/dsh-tools';
import { RemoteError } from '../../client/src/index.ts';
import './world.ts';

/** Preserve the actual DSH consumers, adapting their local cwd canonicalization branch. */
export default class WorldToolRuntime extends ToolRuntime {
  /** The World profile hides inherited tools, then contributes its own reviewed consumers. */
  maskInherited(): () => void { return super.restrict({ allow: [] }); }

  override restrict(filter: ToolRestriction): () => void {
    if (this.ctx.agent && this.ctx.get('remoteWorld')) throw new RemoteError('UNSUPPORTED_TOOL_FILTER', 'Per-Agent tool filters require an adapter for World-owned tools');
    return super.restrict(filter);
  }

  override register(definition: ToolDefinition): () => void {
    const ctx = this.ctx;
    if (!ctx.agent || !ctx.get('remoteWorld') || !['read', 'write', 'edit'].includes(definition.name)) return super.register(definition);
    const fs = ctx.get('fs');
    if (!fs) throw new Error('Remote filesystem consumer has no World filesystem');
    return super.register({ ...definition, async execute(input, exec) {
      const args = input as { file_path: string };
      if (!args || typeof args.file_path !== 'string') return definition.execute(input, exec);
      // Pinned tool-fs otherwise calls local realpath(cwd) whenever path contains '..'.
      // Resolve that path through the World first. Execution identity/approval arguments stay intact.
      if (!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(args.file_path)) return definition.execute(input, exec);
      const target = await fs.resolve(args.file_path, { cwd: exec.agent!.session.header.cwd, signal: exec.signal });
      return definition.execute({ ...args, file_path: fs.processPath(target) }, exec);
    } });
  }
}
