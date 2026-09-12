import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { FileSystem } from '@deepseek-ai/dsh-fs';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import CallEnvironments, { currentEnvironment, inEnvironment } from './call-environment.ts';
import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';
import type { WorkspaceDefinition } from './identity.ts';
import './worlds.ts';

function current(): Context {
  const world = currentEnvironment()?.owner;
  if (!world) throw new RemoteError('WORLD_REQUIRED', 'No active World dispatch; select a concrete provider explicitly');
  return world;
}

export class RoutedFileSystem extends FileSystem {
  override get sandboxMode() { const call = currentEnvironment(); return call ? call.owner.fs.sandboxMode : this.ctx.get('sandboxPolicy')?.defaultMode; }
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

export class RoutedShell extends ShellExecutor {
  override get sandboxMode() { const call = currentEnvironment(); return call ? call.owner.shell.sandboxMode : this.ctx.get('sandboxPolicy')?.defaultMode; }
  resolve(...args: Parameters<ShellExecutor['resolve']>) { return current().shell.resolve(...args); }
  run(...args: Parameters<ShellExecutor['run']>) { return current().shell.run(...args); }
  start(...args: Parameters<ShellExecutor['start']>) { return current().shell.start(...args); }
}

/** Same explicit lookup for model context and approval; no SSH coordinates or credentials. */
export function executionWorldContext(ctx: Context, subject: Agent | ToolExecution) {
  const agent = 'session' in subject ? subject : subject.agent;
  const call = currentEnvironment();
  const target = call?.execution.agent === agent ? call : undefined;
  const owner = target?.owner ?? ctx.executionWorlds.forAgent(agent);
  const definition = target?.definition ?? ctx.executionWorlds.bindings.get(agent!.session.header.id)!;
  const cwd = target?.cwd ?? definition.cwd;
  if (definition.kind === 'local') return Object.freeze({ world: definition.worldId, ...(target?.explicit ? {} : { workspace: definition.id }), kind: definition.kind, cwd, platform: process.platform, arch: process.arch });
  const client = owner.remoteWorld.client;
  const info = client.info;
  return Object.freeze({ world: definition.worldId, ...(target?.explicit ? {} : { workspace: definition.id }), kind: definition.kind, runtime: info.runtime, cwd, helperBuild: info.build,
    enforcement: 'no remote OS sandbox; reads are allowed; workspace-write permits rooted file writes inside the workspace when fs.rooted-publish is available; other restricted operations require approval; approved operations use SSH account permissions',
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
    const owner = current();
    const cwd = (ctx.get('toolEnvironment') as CallEnvironments | undefined)?.cwd(exec) ?? policyRoot;
    if (cwd === undefined) throw new RemoteError('WORLD_REQUIRED', 'Remote shell requires a Session workspace');
    return owner.fs.processPath(await owner.fs.resolve(ctx.get('toolEnvironment') ? cwd : requested ?? cwd, { cwd, signal: exec.signal }));
  } });
  const pending = new WeakMap<Agent, WorkspaceDefinition>();
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
  ctx.on('tools/execute', (exec, next) => {
    const environments = ctx.get('toolEnvironment') as CallEnvironments | undefined;
    if (environments) return environments.run(exec, next);
    const args = exec.arguments as Record<string, unknown> | null;
    if (args?.execution_environment !== undefined) throw new Error('Execution environment selection is unavailable');
    const definition = worlds.bindings.get(exec.agent!.session.header.id)!;
    return inEnvironment({ execution: exec, owner: worlds.forAgent(exec.agent), definition, cwd: definition.cwd, explicit: false }, next);
  }, { prepend: true });
  ctx.systemPrompt.context({ name: 'execution-world', order: -1000,
    text: context => `Execution World (workspace operations execute here):\n${JSON.stringify(executionWorldContext(ctx, context.agent!))}\nThe world field is your World ID; workspace is your Workspace ID. Workspace tools default to this binding. File, search, Bash and terminal_open tools advertising execution_environment accept {world, cwd} for this call only; use configured World IDs and an existing absolute cwd. The Session workspace and its instructions remain unchanged. To discover other configured Worlds, call list_worlds. From a local Session, pass a returned World id to prepare_workspace.world_id, then pass its executionEnvironment Workspace ID string to spawn_teammate.execution_environment (fresh context) or subagent.execution_environment. Team coordination and the task board stay on the host; each member executes project IO in its own binding. Never substitute a World ID or display name for a Workspace ID.` });
}
