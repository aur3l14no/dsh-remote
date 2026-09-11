import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { FileSystem } from '@deepseek-ai/dsh-fs';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import type { WorldDefinition } from './bindings.ts';
import './worlds.ts';

const selected = new AsyncLocalStorage<Context>();
function current(): Context {
  const world = selected.getStore();
  if (!world) throw new RemoteError('WORLD_REQUIRED', 'No active World dispatch; select a concrete provider explicitly');
  return world;
}

export class RoutedFileSystem extends FileSystem {
  resolve(...args: Parameters<FileSystem['resolve']>) { return current().fs.resolve(...args); }
  processPath(...args: Parameters<FileSystem['processPath']>) { return current().fs.processPath(...args); }
  fileUrl(...args: Parameters<FileSystem['fileUrl']>) { return current().fs.fileUrl(...args); }
  contains(...args: Parameters<FileSystem['contains']>) { return current().fs.contains(...args); }
  stat(...args: Parameters<FileSystem['stat']>) { return current().fs.stat(...args); }
  lstat(...args: Parameters<FileSystem['lstat']>) { return current().fs.lstat(...args); }
  readText(...args: Parameters<FileSystem['readText']>) { return current().fs.readText(...args); }
  streamText(...args: Parameters<FileSystem['streamText']>) { return current().fs.streamText(...args); }
  readBytes(...args: Parameters<FileSystem['readBytes']>) { return current().fs.readBytes(...args); }
  readByteRange(...args: Parameters<FileSystem['readByteRange']>) { return current().fs.readByteRange(...args); }
  listDir(...args: Parameters<FileSystem['listDir']>) { return current().fs.listDir(...args); }
  writeText(...args: Parameters<FileSystem['writeText']>) { return current().fs.writeText(...args); }
  editText(...args: Parameters<FileSystem['editText']>) { return current().fs.editText(...args); }
}
export class RoutedSubprocess extends SubprocessRuntime {
  resolveExecutable(...args: Parameters<SubprocessRuntime['resolveExecutable']>) { return current().subprocess.resolveExecutable(...args); }
  spawn(...args: Parameters<SubprocessRuntime['spawn']>) { return current().subprocess.spawn(...args); }
  spawnTerminal(...args: Parameters<SubprocessRuntime['spawnTerminal']>) { return current().subprocess.spawnTerminal(...args); }
}

/** Same explicit lookup for model context and approval; no SSH coordinates or credentials. */
export function executionWorldContext(ctx: Context, subject: Agent | ToolExecution) {
  const agent = 'session' in subject ? subject : subject.agent;
  const owner = ctx.executionWorlds.forAgent(agent);
  const definition = ctx.executionWorlds.bindings.get(agent!.session.header.id)!;
  if (definition.kind === 'local') return Object.freeze({ world: definition.id, kind: 'local', cwd: definition.cwd, platform: process.platform, arch: process.arch });
  const client = owner.remoteWorld.client;
  const info = client.info;
  return Object.freeze({ world: info.world, runtime: info.runtime, cwd: info.cwd, helperBuild: info.build,
    platform: info.platform, arch: info.arch, capabilities: Object.freeze([...info.capabilities]), state: client.state });
}

export const name = 'ssh-world-routing';
export const inject = ['executionWorlds', 'tools', 'systemPrompt'];
export interface Config { providerPaths?: boolean; kind?: 'local' | 'ssh' }
export function apply(ctx: Context, config: Config = {}): void {
  if (scopeOf(ctx) === undefined) throw new RemoteError('WORLD_REQUIRED', 'World routing belongs in a DSH preset');
  const worlds = ctx.executionWorlds;
  function assertDomain(agent: Agent | undefined) {
    worlds.forAgent(agent);
    if (config.kind && worlds.bindings.get(agent!.session.header.id)?.kind !== config.kind) {
      throw new RemoteError('WORLD_MISMATCH', 'Agent preset does not belong to the bound execution environment');
    }
  }
  if (config.providerPaths) ctx.provide('toolBashWorkdir', { async resolve(exec: ToolExecution, requested: string | undefined, policyRoot: string | undefined) {
    const owner = worlds.forAgent(exec.agent);
    const cwd = policyRoot ?? exec.agent?.session.header.cwd;
    if (cwd === undefined) throw new RemoteError('WORLD_REQUIRED', 'Remote shell requires a Session workspace');
    return owner.fs.processPath(await owner.fs.resolve(requested ?? cwd, { cwd, signal: exec.signal }));
  } });
  const pending = new WeakMap<Agent, WorldDefinition>();
  ctx.on('agent/created', ({ agent }) => {
    if (worlds.bindings.get(agent.session.header.id)) { worlds.adopt(agent); return; }
    const inherited = worlds.inherited(agent);
    if (!inherited) throw new RemoteError('WORLD_REQUIRED', 'Bind the Session before creating its Agent');
    pending.set(agent, inherited);
  });
  ctx.on('agent/session-start', ({ agent, source }) => {
    const inherited = pending.get(agent);
    if (!inherited) return;
    // DSH contains failures from this notification. Keep the Agent blocked until commit succeeds.
    pending.delete(agent);
    if (source !== 'startup') throw new RemoteError('WORLD_REQUIRED', 'Resume requires an existing saved binding');
    worlds.bindings.bind(agent.session.header.id, inherited);
    worlds.adopt(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => { pending.delete(agent); worlds.forget(agent); });
  ctx.tools.guard(exec => {
    try { assertDomain(exec.agent); } catch (error) { return String(error); }
    const args = exec.arguments as { file_path?: unknown } | null;
    if (config.kind !== 'local' && !config.providerPaths && ['read', 'write', 'edit'].includes(exec.name) && typeof args?.file_path === 'string'
        && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(args.file_path)) return 'Pinned DSH tool-fs resolves parent paths locally; this request requires an upstream World-aware fix';
    return undefined;
  });
  ctx.on('tools/execute', (exec, next) => selected.run(worlds.forAgent(exec.agent), next));
  ctx.systemPrompt.context({ name: 'execution-world', order: -1000,
    text: context => `Execution World (workspace operations execute here):\n${JSON.stringify(executionWorldContext(ctx, context.agent!))}` });
}
