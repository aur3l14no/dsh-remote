import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets, { serviceForAgent } from '@deepseek-ai/dsh-agent-presets';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Client } from '../../packages/client/src/index.ts';
import { worldPlugin } from '../../packages/dsh-ssh/src/world.ts';
import * as WorldContext from '../../packages/dsh-ssh/src/context.ts';
import SshFileSystem from '../../packages/dsh-ssh/src/fs.ts';
import SshSubprocess from '../../packages/dsh-ssh/src/subprocess.ts';
import { applyTerminalConsumers } from './terminal-consumers.ts';
export { serviceForAgent };

/** Fixture application policy. All Agent, preset and tool services are unchanged DSH implementations. */
export async function presetHarness(root: string, worlds: { id: string; client: Client; ripgrep: string; shell?: string }[]) {
  const ctx = new Context();
  try {
    ctx.baseUrl = pathToFileURL(`${root}/`).href;
    await ctx.plugin(Loader);
    ctx.loader.builtins = { include: Include, group: Group, fs: SshFileSystem, subprocess: SshSubprocess,
      'world-context': WorldContext, 'file-tools': FileTools, 'search-tools': SearchTools,
      'terminal-consumers': { inject: ['remoteWorld', 'subprocess'], apply: applyTerminalConsumers } };
    for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, AgentRegistry, SessionProjectionRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(AgentLoop, { agents: [] });
    const packagedRg = await resolveRgPath();
    for (const world of worlds) {
      await mkdir(`${root}/${world.id}`, { recursive: true });
      ctx.loader.builtins[`world-${world.id}`] = worldPlugin(world.client, async () => {});
      const config = [{ id: 'world', name: 'cordis:group', isolate: { remoteWorld: true, fs: true, subprocess: true, terminals: true, jobs: true, sandboxPolicy: true }, config: [
        { id: 'runtime', name: `cordis:world-${world.id}` },
        { id: 'fs', name: 'cordis:fs', config: { textMaxBytes: 33554432, diffBasisMaxBytes: 1048576 } },
        { id: 'subprocess', name: 'cordis:subprocess', config: { executables: { [packagedRg]: world.ripgrep } } },
        { id: 'context', name: 'cordis:world-context' },
        { id: 'files', name: 'cordis:file-tools' },
        { id: 'search', name: 'cordis:search-tools', config: { sampleOverCapGlobResults: false } },
        ...(world.shell ? [{ id: 'terminal', name: 'cordis:terminal-consumers', config: { shell: world.shell } }] : []),
      ] }];
      await writeFile(`${root}/${world.id}/agent.cordis.yml`, JSON.stringify(config));
    }
    await ctx.plugin(AgentPresets, { default: worlds[0]!.id, roots: [{ path: root, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
