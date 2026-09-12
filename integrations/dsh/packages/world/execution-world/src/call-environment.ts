import type { Agent } from '@deepseek-ai/dsh-agent';
import { fileReference } from './resource-reference.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ToolExecution, ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import type { WorkspaceDefinition } from './identity.ts';
import type {} from './worlds.ts';
import type {} from '../../../workspace/portable-workspace/src/registry.ts';

export interface CallEnvironment {
  readonly execution: ToolExecution;
  readonly owner: Context;
  readonly definition: WorkspaceDefinition;
  readonly cwd: string;
  readonly explicit: boolean;
}
const active = new AsyncLocalStorage<CallEnvironment>();
export const currentEnvironment = () => active.getStore();
export const inEnvironment = <T>(environment: CallEnvironment, run: () => Promise<T>) => active.run(environment, run);
export function operationOf(tool: ToolDefinition | undefined) {
  return (tool as (ToolDefinition & { executionEnvironment?: { access: 'read' | 'write' | 'execute'; path?: string; directory?: string; selection?: boolean; resource?: { kind: string; parameter: string }; produces?: { kind: string; result: string } } }) | undefined)?.executionEnvironment;
}
const selection = z.object({ world: z.string().min(1), cwd: z.string().startsWith('/') }).strict();

/** One resolved target shared by tool providers, policy and approval context. */
export default class CallEnvironments extends Service {
  private readonly resources = new WeakMap<Agent, Map<string, Omit<CallEnvironment, 'execution'>>>();
  static inject = ['executionWorlds', 'worldPortableWorkspaces', 'tools'];
  readonly parameters = Object.freeze({ execution_environment: {
    type: 'object', additionalProperties: false, required: ['world', 'cwd'],
    properties: { world: { type: 'string', description: 'Configured World ID returned by list_worlds.' },
      cwd: { type: 'string', description: 'Existing absolute working directory on that World.' } },
    description: 'Execute this call in a different environment without changing your Session workspace. Omit to use your Session environment.',
  } });
  constructor(ctx: Context) { super(ctx, 'toolEnvironment'); }
  remember(agent: Agent, kind: string, id: string, environment: Omit<CallEnvironment, 'execution'>): void {
    let resources = this.resources.get(agent);
    if (!resources) this.resources.set(agent, resources = new Map());
    resources.set(kind + ':' + id, environment);
  }
  cwd(exec: ToolExecution): string | undefined {
    const call = active.getStore();
    return call?.execution === exec ? call.cwd : exec.agent?.session.header.cwd;
  }
  fileEnvironment(): { cwd: string; base: string } | undefined {
    const call = active.getStore();
    if (!call?.explicit) return undefined;
    return { cwd: call.cwd, base: fileReference(call.definition, call.cwd, call.cwd.replace(/\/$/, '') + '/') };
  }
  fileReference(exec: ToolExecution, path: string): string | undefined {
    const call = active.getStore();
    if (call?.execution !== exec) throw new Error('File publication requires its active execution environment');
    return call.explicit ? fileReference(call.definition, call.cwd, path) : undefined;
  }
  async run(exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const source = this.ctx.executionWorlds.forAgent(exec.agent);
    const bound = this.ctx.executionWorlds.bindings.get(exec.agent!.session.header.id)!;
    const args = exec.arguments as Record<string, unknown> | null;
    const tool = this.ctx.tools.get(exec.name, exec.agent);
    const operation = operationOf(tool);
    // Argument validation belongs to the tool's schema. Only consume our routing declaration.
    const input = operation && args && typeof args === 'object' ? args.execution_environment : undefined;
    let owner = source;
    let definition = bound;
    let cwd = bound.cwd;
    const resourceId = operation?.resource && args?.[operation.resource.parameter];
    const remembered = typeof resourceId === 'string' ? this.resources.get(exec.agent!)?.get(operation!.resource!.kind + ':' + resourceId) : undefined;
    if (operation?.resource && !remembered) throw new Error('No execution environment is recorded for this resource');
    if (remembered) { owner = remembered.owner; definition = remembered.definition; cwd = remembered.cwd; }
    if (input !== undefined) {
      if (operation?.selection === false) throw new Error('This tool does not support an execution environment');
      const target = selection.parse(input);
      const prepared = await this.ctx.worldPortableWorkspaces.prepareOperation(target.world, target.cwd, exec.signal);
      owner = prepared.owner; definition = prepared.definition; cwd = prepared.cwd;
    }
    const requestedDirectory = operation?.directory ? args?.[operation.directory] : undefined;
    if (requestedDirectory !== undefined) {
      if (typeof requestedDirectory !== 'string') throw new Error('Execution working directory must be a string');
      const directory = await owner.fs.resolve(requestedDirectory, { cwd, signal: exec.signal });
      if ((await owner.fs.stat(directory, exec.signal))?.type !== 'directory') throw new Error('Execution working directory does not exist');
      cwd = owner.fs.processPath(directory);
    }
    exec.signal.throwIfAborted();
    const environment = Object.freeze({ execution: exec, owner, definition, cwd, explicit: input !== undefined || remembered?.explicit === true });
    return active.run(environment, async () => {
      const result = await next();
      if (!result.isError && operation?.produces && result.value && typeof result.value === 'object') {
        const id = (result.value as Record<string, unknown>)[operation.produces.result];
        if (typeof id === 'string') {
          this.remember(exec.agent!, operation.produces.kind, id, { owner, definition, cwd, explicit: environment.explicit });
        }
      }
      return result;
    });
  }
}
