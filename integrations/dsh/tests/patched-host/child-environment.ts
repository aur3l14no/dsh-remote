/** Native child lifecycle plus real World providers; Linux/SSH uses the same gate with target fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-presets';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import SandboxedFs from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Controls from '@deepseek-ai/dsh-tool-subagent-control';
import * as WorldTools from '../../packages/world/execution-world/src/tools.ts';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import { MockAdapter, textResponse } from '@dsh-test/mock-adapter';
import { runtime } from '../../../../runtime/tests/client/support.ts';
import { BindingStore } from '../../packages/world/execution-world/src/bindings.ts';
import { executionWorldsPlugin } from '../../packages/world/execution-world/src/worlds.ts';
import * as Routing from '../../packages/world/execution-world/src/routing.ts';
import Registry from '../../packages/workspace/portable-workspace/src/registry.ts';
import * as NativeWorkspaces from '../../packages/workspace/local-workspace/src/native.ts';
import * as ChildEnvironment from '../../packages/workspace/portable-workspace/src/child-environment.ts';

const base = await mkdtemp('/tmp/dsh-child-environment-');
const ctx = new Context();
const scratch: string[] = [];
try {
  await mkdir(`${base}/local`); await mkdir(`${base}/target`);
  await writeFile(`${base}/local/marker.txt`, 'LOCAL ONLY');
  await writeFile(`${base}/target/marker.txt`, 'REMOTE ONLY');
  BindingStore.create(`${base}/bindings.json`);
  ctx.baseUrl = pathToFileURL(`${base}/`).href;
  await ctx.plugin(Loader);
  ctx.loader.builtins = { include: Include, group: Group, fs: Routing.RoutedFileSystem,
    subprocess: Routing.RoutedSubprocess, routing: Routing, files: FileTools, controls: Controls, worldTools: WorldTools };
  for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, AgentRegistry, SessionProjectionRegistry, Storage, TypertRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(JsonlPersistence, { root: `${base}/sessions`, compression: 'none' });
  await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' });
  await ctx.plugin(JsonStorage, { root: `${base}/registry` });
  await ctx.plugin(StorageDomain, { backend: 'json' });
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' });
  await ctx.plugin(SandboxedFs, { cwd: `${base}/local` });
  await ctx.plugin(LocalSubprocess);
  await ctx.plugin(executionWorldsPlugin(async definition => {
    const r = await runtime({ world: definition.id, lease: 5000 });
    return { client: r.client, ripgrep: process.env.DSH_TEST_RG!, close: () => r.close() };
  }), { local: ctx, bindingFile: `${base}/bindings.json`, packagedRipgrep: process.env.DSH_TEST_RG!,
    bootstrap: { manifest: {}, cacheDir: base } });
  for (const preset of ['standard', 'remote']) {
    await mkdir(`${base}/${preset}`);
    await writeFile(`${base}/${preset}/agent.cordis.yml`, JSON.stringify([
      { name: 'cordis:group', isolate: { fs: true, subprocess: true, toolBashWorkdir: true }, config: [
        { name: 'cordis:fs' }, { name: 'cordis:subprocess' },
        { name: 'cordis:routing', config: { kind: preset === 'standard' ? 'local' : 'ssh', providerPaths: true } },
        { name: 'cordis:files' }, { name: 'cordis:controls' }, { name: 'cordis:worldTools' },
      ] },
    ]));
  }
  await ctx.plugin(AgentPresets, { default: 'standard', roots: [{ path: base, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
  await ctx.plugin(NativeWorkspaces);
  await ctx.plugin(Registry, { worlds: [{ id: 'target', name: 'Target', target: { kind: 'ssh', host: 'fixture.invalid' } }] });
  await ctx.plugin(ChildEnvironment);
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn, { providerName: 'spawn' });
  await ctx.plugin(AgentLoop, { agents: [] });
  const mock = new MockAdapter(Array.from({ length: 50 }, () => textResponse('child complete')));
  ctx.llm.registerAdapter(['mock'], mock);
  const registry = ctx.worldPortableWorkspaces;
  const local = await registry.createInWorld('local', `${base}/local`);
  const target = await registry.createInWorld('target', `${base}/target`);
  const parentId = SessionId('leader');
  await ctx.executionWorlds.bind(parentId, registry.definition(local.id));
  const parent = await ctx.agents.create({ sessionId: parentId, meta: { cwd: local.path, agentPreset: 'standard' },
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async c => { await ctx.agentPresets.mount(c, 'standard'); } });
  await local.attachSession(parentId);
  const read = async (agent: typeof parent.agent) => ctx.tools.execute({ agent, name: 'read', arguments: { file_path: 'marker.txt' },
    callId: ToolCallId('probe'), signal: AbortSignal.timeout(10000) });
  // A running parent's standing preset survives changes to its source file.
  await writeFile(`${base}/standard/agent.cordis.yml`, '[]');
  const ordinary = await ctx.subagents.start('spawn', { parent: parent.agent,
    prompt: [{ type: 'text', text: 'Read only' }], toolFilter: { allow: ['read'] }, signal: AbortSignal.timeout(15000) });
  assert.ok(JSON.stringify(await read(ordinary.localAgent!)).includes('LOCAL ONLY'));
  await ordinary.result;
  await ordinary.dispose();
  const run = await ctx.subagents.start('spawn', { parent: parent.agent, executionEnvironment: target.id,
    prompt: [{ type: 'text', text: 'Read-only exploration. Do not change files or configuration.' }],
    toolFilter: { allow: ['read'] }, signal: AbortSignal.timeout(15000) });
  const child = run.localAgent!;
  assert.equal(child.session.header.origin, 'subagent');
  assert.equal(child.session.header.parentSession, parentId);
  assert.equal(child.session.header.cwd, target.path);
  assert.equal(child.session.header.agentPreset, 'remote');
  assert.equal(ctx.executionWorlds.bindings.get(child.id)!.worldId, 'target');
  assert.ok(JSON.stringify(await read(child)).includes('REMOTE ONLY'));
  assert.ok(JSON.stringify(await read(parent.agent)).includes('LOCAL ONLY'));
  assert.deepEqual(ctx.tools.schemas(child).map(tool => tool.name), ['read']);
  const deniedWrite = await ctx.tools.execute({ agent: child, name: 'write', arguments: { file_path: 'marker.txt', content: 'forbidden' },
    callId: ToolCallId('denied-write'), signal: AbortSignal.timeout(5000) });
  assert.equal(deniedWrite.isError, true);
  assert.ok(JSON.stringify(await read(child)).includes('REMOTE ONLY'));
  assert.equal((await registry.contextForSession(child.id)).id, target.id);
  assert.deepEqual(target.sessionIds, [], 'Child must never become a top-level member');
  assert.equal((await run.result).stopReason, 'completed');
  const nested = await ctx.subagents.start('spawn', { parent: child, prompt: [{ type: 'text', text: 'Read only' }], signal: AbortSignal.timeout(15000) });
  assert.equal(ctx.executionWorlds.bindings.get(nested.localAgent!.id)!.id, registry.definition(target.id).id);
  assert.equal((await registry.contextForSession(nested.localAgent!.id)).id, target.id);
  await nested.result; await nested.dispose(); await run.dispose();
  await assert.rejects(ctx.subagents.start('spawn', { parent: parent.agent, executionEnvironment: 'missing', prompt: [], signal: AbortSignal.timeout(10000) }));
  assert.deepEqual(target.sessionIds, []);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(ctx.subagents.startContinuable({ provider: 'spawn', childId: SessionId('cancelled-child'), label: 'Cancelled',
    request: { parent: parent.agent, executionEnvironment: target.id, prompt: [] }, signal: cancelled.signal }));
  assert.equal(ctx.agents.get(SessionId('cancelled-child')), undefined);
  assert.equal(ctx.executionWorlds.bindings.get('cancelled-child'), undefined);
  const environment = ctx.get('childExecutionEnvironment')!;
  const prepare = environment.prepare;
  let rejectedId: string | undefined;
  environment.prepare = async request => {
    const prepared = await prepare(request); rejectedId = request.sessionId;
    return { ...prepared, validate() { throw new Error('Publication revoked'); } };
  };
  try {
    await assert.rejects(ctx.subagents.start('spawn', { parent: parent.agent, executionEnvironment: target.id, prompt: [], signal: AbortSignal.timeout(10000) }), /Publication revoked/);
    assert.ok(rejectedId); assert.equal(ctx.agents.get(SessionId(rejectedId)), undefined);
  } finally { environment.prepare = prepare; }

  const finished = () => new Promise<void>(resolve => {
    const off = ctx.on('subagent/end', () => { off(); resolve(); });
  });
  let done = finished();
  const started = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'Read-only remote inspection',
    request: { parent: parent.agent, executionEnvironment: target.id, toolFilter: { allow: ['read'] }, prompt: [{ type: 'text', text: 'Read only' }] },
    signal: AbortSignal.timeout(15000) });
  await done;
  assert.equal(ctx.agents.get(started.childId), undefined);
  await ctx.sessionPersistence.flush();
  assert.equal((await registry.contextForSession(started.childId)).id, target.id);
  done = finished();
  await ctx.subagents.sendMessage(parent.agent, started.childId, [{ type: 'text', text: 'Continue read-only inspection' }], { signal: AbortSignal.timeout(15000) });
  await done;
  assert.equal(ctx.executionWorlds.bindings.get(started.childId)!.id, registry.definition(target.id).id);
  assert.deepEqual(target.sessionIds, []);
  await parent.agent.whenIdle();
  assert.ok(JSON.stringify(parent.agent.session.snapshotEvents()).includes('child complete'), 'Native settlement must reach the leader');
  const execute = (name: string, args: object) => ctx.tools.execute({ agent: parent.agent, name, arguments: args,
    callId: ToolCallId('world-' + name), signal: AbortSignal.timeout(30000) });
  const listed = await execute('list_worlds', { pattern: 'tar*' });
  assert.equal(listed.isError, false, JSON.stringify(listed));
  assert.ok(JSON.stringify(listed).includes('target'));
  const prepared = await execute('prepare_workspace', { world_id: 'target' });
  assert.equal(prepared.isError, false, JSON.stringify(prepared));
  const block = prepared.content.find(block => block.type === 'text');
  assert.ok(block?.type === 'text');
  const result = JSON.parse(block.text);
  scratch.push(result.path);
  assert.equal(result.worldId, 'target');
  assert.notEqual(result.executionEnvironment, result.worldId);
  assert.equal(registry.definition(result.executionEnvironment).cwd, result.path);
  const context = Routing.executionWorldContext(ctx, parent.agent);
  assert.equal(context.world, 'local');
  assert.equal(context.workspace, registry.definition(local.id).id);
  await parent.dispose();
  console.log('PASS local leader → native SSH child: explicit binding, scoped read tools, nested inheritance, native settlement and cold continuation; no top-level child membership');
} finally {
  await ctx.fiber.dispose();
  for (const path of scratch) {
    assert.match(path, /^\/(?:private\/)?tmp\/dsh-workspace\.[A-Za-z0-9]{10}$/);
    await rm(path, { recursive: true, force: true });
  }
  await rm(base, { recursive: true, force: true });
}
