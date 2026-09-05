import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type { Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import WorldSessionPersistence from '../../packages/dsh-ssh/src/persistence.ts';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver';
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-test/mock-adapter';
import WorldAgentRegistry from '../../packages/dsh-ssh/src/agents.ts';
import type { WorldBinding } from '../../packages/dsh-ssh/src/agents.ts';
import WorldToolRuntime from '../../packages/dsh-ssh/src/tools.ts';
import type { WorldDefinition } from '../../packages/dsh-ssh/src/world-pool.ts';
import { runtime, fixture as nativeFixture } from '../client/support.ts';
import { remoteRuntime } from './remote-runtime.ts';

const ssh = !!process.env.DSH_TEST_HOST;
const localRg = process.env.DSH_TEST_RG ? resolve(process.env.DSH_TEST_RG) : undefined;
const fixture = ssh ? process.env.DSH_TEST_REMOTE_FIXTURE : nativeFixture;
assert.ok(localRg && fixture, 'Explicit local and target-native artifacts required');
const local = await mkdtemp('/tmp/dsh-agent-local.');
const originalExecPath = process.execPath, originalPkg = Reflect.get(process, 'pkg');
type Runtime = Awaited<ReturnType<typeof runtime>> | Awaited<ReturnType<typeof remoteRuntime>>;
const runtimes: Runtime[] = [];
const contexts: Context[] = [];
const start = async (world: string, cwd?: string) => {
  const result = ssh ? await remoteRuntime(world, cwd) : await runtime({ world, cwd, lease: 5000 });
  runtimes.push(result);
  return result;
};
const agentOptions = { provider: 'mock', model: 'mock' };
const approvals: string[] = [];
async function harness(worlds: WorldDefinition[], adapter = new MockAdapter([]), afterAppend?: () => Promise<void>) {
  const ctx = new Context(); contexts.push(ctx);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(WorldToolRuntime, { mode: 'native' });
  await ctx.plugin(WorldAgentRegistry, { worlds });
  class Persistence extends WorldSessionPersistence {
    override async create(...args: Parameters<WorldSessionPersistence['create']>) {
      const handle = await super.create(...args);
      const append = handle.append.bind(handle);
      handle.append = async (...batch) => { await append(...batch); await afterAppend?.(); };
      return handle;
    }
  }
  await ctx.plugin(Persistence, { root: `${local}/sessions` });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['mock'], adapter);
  ctx.on('tools/pre-execute', async (exec, next) => {
    approvals.push(JSON.stringify((ctx.agents as WorldAgentRegistry).contextFor(exec)));
    return next();
  });
  return ctx;
}
const call = (agent: Agent, name: string, args: unknown) => agent.ctx.tools.execute({ name, arguments: args,
  agent, callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(10000) });
const turn = async (agent: Agent) => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the workspace.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
};
try {
  process.execPath = `${local}/harness`; Reflect.set(process, 'pkg', {});
  await copyFile(localRg, `${process.execPath}-rg`);
  await writeFile(`${local}/sentinel.txt`, 'local-only\n');
  const first = await start('world-a'), second = await start('world-b');
  let starts = 0, closes = 0;
  const definitions: WorldDefinition[] = [first, second].map((initial, index) => ({
    id: index ? 'world-b' : 'world-a', target: index ? 'target-b' : 'target-a', cwd: initial.dir,
    open: async () => {
      starts++;
      const r = initial.client.state === 'ready' ? initial : await start(index ? 'world-b' : 'world-a', initial.dir);
      const ripgrep = 'ripgrep' in r ? r.ripgrep : ssh ? process.env.DSH_TEST_REMOTE_RG : localRg;
      assert.ok(ripgrep);
      return { client: r.client, ripgrep, async close() { closes++; await r.client.shutdown(); } };
    },
  }));
  const adapter = new MockAdapter([
    toolCallResponse('read', 'read', { file_path: 'sentinel.txt' }),
    toolCallResponse('grep', 'grep', { pattern: 'remote-only', path: 'sentinel.txt' }),
    toolCallResponse('exec', 'exec', { argv: [fixture, 'argv', 'literal;$(no-shell)'] }),
    textResponse('done'), textResponse('child done'), textResponse('resumed'),
  ]);
  const ctx = await harness(definitions, adapter);
  const registry = ctx.agents as WorldAgentRegistry;
  let localCalls = 0;
  ctx.tools.register({ name: 'local-bypass', description: 'test trap', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [] }, async execute() { localCalls++; return {}; } });
  const announced: string[] = [];
  ctx.on('agent/created', ({ agent }) => {
    const binding = registry.contextFor(agent);
    assert.equal(binding.state, 'ready'); assert.equal(agent.session.header.cwd, binding.world.cwd);
    assert.equal(registry.scopeFor(agent).remoteWorld.client.info.runtime, binding.runtime);
    announced.push(agent.id);
  });
  await assert.rejects(ctx.agents.create({ sessionId: SessionId('unbound') }), { code: 'WORLD_REQUIRED' });
  await assert.rejects(ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('factory-bypass') }), { code: 'WORLD_REQUIRED' });
  assert.equal(ctx.sessions.get(SessionId('factory-bypass')), undefined);
  const root = await ctx.agents.create({ sessionId: SessionId('root'), world: 'world-a', agentOptions });
  const peer = await ctx.agents.create({ sessionId: SessionId('peer'), world: 'world-a', agentOptions });
  assert.equal(starts, 1);
  assert.notEqual(registry.scopeFor(root.agent).subprocess, registry.scopeFor(peer.agent).subprocess);
  assert.equal(registry.scopeFor(root.agent).remoteWorld.client, registry.scopeFor(peer.agent).remoteWorld.client);
  await registry.scopeFor(root.agent).fs.writeText(await registry.scopeFor(root.agent).fs.resolve('sentinel.txt'), 'remote-only\n');
  if (ssh) await assert.rejects(readFile(`${first.dir}/sentinel.txt`), { code: 'ENOENT' });
  await turn(root.agent);
  assert.equal(adapter.requests.length, 4);
  const request = JSON.stringify(adapter.requests[0]);
  assert.ok(request.includes('execution-world') && request.includes('world-a') && request.includes(first.dir));
  assert.ok(!request.includes('local-bypass'));
  const log = JSON.stringify(root.agent.session.snapshotEvents());
  const outcomes = root.agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every(event => !JSON.stringify(event.data).includes('"isError":true')), JSON.stringify(outcomes));
  assert.throws(() => validateStoredEvents(root.agent.session.header, [...root.agent.session.snapshotEvents()]), /unknown to this harness/);
  assert.ok(log.includes('remote-only') && log.includes('literal;$(no-shell)'));
  assert.ok(!log.includes('local-only'));
  assert.equal((await call(root.agent, 'local-bypass', {})).isError, true);
  assert.equal(localCalls, 0);
  assert.ok(approvals.length >= 3 && approvals.every(value => !value.includes('token')));
  assert.ok(Object.isFrozen(registry.contextFor(root.agent).world));
  assert.throws(() => { root.agent.ctx[Context.isolate] = {}; }, TypeError);
  const nativeRealpath = realpathSync.native;
  let localResolutions = 0;
  realpathSync.native = ((...args: Parameters<typeof nativeRealpath>) => {
    if (String(args[0]) === first.dir) { localResolutions++; throw new Error('Remote cwd reached local realpath'); }
    return Reflect.apply(nativeRealpath, realpathSync, args);
  }) as typeof nativeRealpath;
  try {
    const traversed = await call(root.agent, 'read', { file_path: `${first.dir}/../${first.dir.split('/').at(-1)}/sentinel.txt` });
    assert.notEqual(traversed.isError, true, JSON.stringify(traversed));
    assert.ok(JSON.stringify(traversed).includes('remote-only'));
    assert.equal(localResolutions, 0);
  } finally { realpathSync.native = nativeRealpath; }
  for (const [name, args] of [
    ['write', { file_path: 'edited.txt', content: 'first\r\nneedle\r\n' }],
    ['edit', { file_path: 'edited.txt', old_string: 'needle', new_string: 'changed' }],
    ['glob', { pattern: '*.txt' }],
  ] as const) {
    const result = await call(root.agent, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    if (name === 'glob') assert.ok(JSON.stringify(result).includes('edited.txt'));
  }
  assert.equal(await registry.scopeFor(root.agent).fs.readText(await registry.scopeFor(root.agent).fs.resolve('edited.txt')), 'first\r\nchanged\r\n');
  console.log('PASS actual Agent loop: remote FS/search/argv, model context, approval metadata and local bypass rejection');

  const storageFailure = await ctx.agents.create({ sessionId: SessionId('storage-failure'), world: 'world-a', agentOptions });
  storageFailure.agent.session.append('execution-world/bound', { ...registry.contextFor(storageFailure.agent), schema: 2 } as unknown as WorldBinding);
  const blockedWrite = await call(storageFailure.agent, 'write', { file_path: 'must-not-exist.txt', content: 'must not run' });
  assert.equal(blockedWrite.isError, true);
  assert.equal(await registry.scopeFor(root.agent).fs.stat(await registry.scopeFor(root.agent).fs.resolve('must-not-exist.txt')), undefined);
  const requestsBeforeFailure = adapter.requests.length;
  await turn(storageFailure.agent);
  assert.equal(adapter.requests.length, requestsBeforeFailure);
  await storageFailure.dispose().catch(error => assert.match(String(error), /World binding|dispose/i));
  console.log('PASS required-record storage failure blocks model and remote tool dispatch');

  const child = await startInProcessRun({ parent: root.agent, signal: AbortSignal.timeout(10000),
    prompt: [{ type: 'text', text: 'Child task' }], descriptor: { version: 1, mode: 'one-shot', provider: 'in-process' } }, {});
  const childResult = await child.result;
  assert.equal(childResult.stopReason, 'completed');
  assert.ok(JSON.stringify(adapter.requests[4]).includes('world-a'));
  assert.equal(starts, 1);
  await child.dispose();
  for (const toolFilter of [{ deny: ['read'] }, { allow: [] }]) {
    await assert.rejects(startInProcessRun({ parent: root.agent, signal: AbortSignal.timeout(10000), toolFilter,
      prompt: [{ type: 'text', text: 'Filtered child' }], descriptor: { version: 1, mode: 'one-shot', provider: 'in-process' } }, {}), { code: 'UNSUPPORTED_TOOL_FILTER' });
  }
  await assert.rejects(root.agent.ctx.agents.create({ sessionId: SessionId('cross-child'), world: 'world-b' }), { code: 'WORLD_HANDOFF_REQUIRED' });
  const other = await registry.handoff(root.agent, { sessionId: SessionId('other'), world: 'world-b', agentOptions });
  assert.equal(registry.contextFor(root.agent).world.id, 'world-a');
  assert.equal(registry.contextFor(other.agent).world.id, 'world-b');
  assert.ok(other.agent.session.snapshotEvents().some(event => event.type === 'execution-world/handoff'));
  console.log('PASS actual in-process child inheritance and explicit cross-World new-Agent handoff');

  const hold = (agent: Agent) => registry.scopeFor(agent).subprocess.spawn({ argv: [fixture, 'hold'], cwd: agent.session.header.cwd!, graceMs: 200,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } });
  const owned = hold(root.agent), surviving = hold(peer.agent), independent = hold(other.agent);
  await delay(100);
  const firstEpoch = registry.contextFor(root.agent).runtime;
  await root.dispose();
  const persisted = await ctx.sessionPersistence.open(SessionId('root'), 'read');
  try {
    const history = JSON.stringify(await persisted.read());
    assert.ok(history.includes('remote-only') && history.includes('literal;$(no-shell)') && history.includes('request/header'));
  } finally { await persisted.close(); }
  assert.equal(await owned.waitForExit(), true);
  assert.equal(await surviving.waitForExit(AbortSignal.timeout(100)), false);
  assert.equal(first.client.state, 'ready');
  await assert.rejects(ctx.agents.resume({ resumeSessionId: SessionId('root'), world: 'world-b' }), { code: 'WORLD_MISMATCH' });
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('root'), agentOptions });
  assert.equal(registry.contextFor(resumed.agent).runtime, firstEpoch);
  await turn(resumed.agent);
  await resumed.dispose(); await peer.dispose();
  assert.equal(first.client.state, 'closed');
  assert.equal(second.client.state, 'ready');
  assert.equal(await independent.waitForExit(AbortSignal.timeout(100)), false);
  const fresh = await ctx.agents.resume({ resumeSessionId: SessionId('root'), agentOptions });
  assert.notEqual(registry.contextFor(fresh.agent).runtime, firstEpoch);
  assert.equal(adapter.requests.length, 6, 'Resume never autonomously drives old commands');
  await fresh.dispose(); await other.dispose();
  assert.equal(closes, 3);
  console.log('PASS runtime sharing, owner cleanup, required local World Session resume and explicit fresh epoch without replay');

  const count = announced.length;
  await assert.rejects(ctx.agents.create({ sessionId: SessionId('setup-failed'), world: 'world-a', setup() { throw new Error('setup failed'); } }), /setup failed/);
  assert.equal(announced.length, count); assert.equal(ctx.sessions.get(SessionId('setup-failed')), undefined);
  await assert.rejects(ctx.agents.create({ sessionId: SessionId('commit-failed'), world: 'world-a', setup() { return { commit() { throw new Error('commit failed'); } }; } }), /commit failed/);
  assert.equal(announced.length, count);
  console.log('PASS unpublished setup/commit rollback');

  const cancelled = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = ctx.agents.create({ sessionId: SessionId('cancelled'), world: 'world-a', signal: cancelled.signal,
    setup: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  cancelled.abort(new Error('cancel setup')); release.resolve();
  await assert.rejects(pending, /cancel setup/);
  assert.equal(announced.length, count);
  assert.equal(ctx.sessions.get(SessionId('cancelled')), undefined);
  console.log('PASS cancellation during unpublished setup');

  await ctx.fiber.dispose();
  const mismatch = await harness(definitions.map(d => ({ ...d, target: 'changed-target' })));
  const beforeMismatch = starts;
  await assert.rejects(mismatch.agents.resume({ resumeSessionId: SessionId('root') }), { code: 'WORLD_MISMATCH' });
  assert.equal(starts, beforeMismatch);
  await mismatch.fiber.dispose();
  const cold = await harness(definitions);
  const recovered = await cold.agents.resume({ resumeSessionId: SessionId('root'), agentOptions });
  assert.ok(JSON.stringify(recovered.agent.session.snapshotEvents()).includes('literal;$(no-shell)'));
  assert.equal((cold.agents as WorldAgentRegistry).contextFor(recovered.agent).world.id, 'world-a');
  await recovered.dispose();
  await cold.fiber.dispose();
  console.log('PASS cold application resume and refusal of changed target before bootstrap');

  let victim: Runtime['client'] | undefined;
  const gap = await harness(definitions, undefined, async () => { await victim!.shutdown(); });
  let gapAnnouncements = 0;
  gap.on('agent/created', () => { gapAnnouncements++; });
  await assert.rejects(gap.agents.create({ sessionId: SessionId('publication-gap'), world: 'world-a', setup: scope => {
    victim = (gap.agents as WorldAgentRegistry).scopeFor(scope.agent!).remoteWorld.client;
  } }), { code: 'WORLD_NOT_READY' });
  assert.equal(gapAnnouncements, 0);
  assert.equal(gap.sessions.get(SessionId('publication-gap')), undefined);
  await gap.fiber.dispose();
  console.log('PASS World loss during persistence await after setup commit, before announcement');

  const lateRuntime = await start('late-world', first.dir);
  const provisioned = Promise.withResolvers<void>(), finishProvisioning = Promise.withResolvers<void>();
  const late = await harness([{ id: 'late-world', target: 'late-target', cwd: first.dir, open: async () => {
    provisioned.resolve(); await finishProvisioning.promise;
    const ripgrep = 'ripgrep' in lateRuntime ? lateRuntime.ripgrep : ssh ? process.env.DSH_TEST_REMOTE_RG : localRg;
    assert.ok(ripgrep);
    return { client: lateRuntime.client, ripgrep, close: () => lateRuntime.client.shutdown() };
  } }]);
  const lateAbort = new AbortController();
  const lateCreation = late.agents.create({ sessionId: SessionId('late-owner'), world: 'late-world', signal: lateAbort.signal });
  await provisioned.promise;
  lateAbort.abort(new Error('cancel provisioning')); finishProvisioning.resolve();
  await assert.rejects(lateCreation, /cancel provisioning/);
  assert.equal(lateRuntime.client.state, 'closed');
  assert.equal(late.agents.get(SessionId('late-owner')), undefined);
  console.log('PASS late bootstrap remains owned and closes after cancelled Agent creation');
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
  for (const r of runtimes.reverse()) await r.close();
  process.execPath = originalExecPath;
  if (originalPkg === undefined) Reflect.deleteProperty(process, 'pkg'); else Reflect.set(process, 'pkg', originalPkg);
  await rm(local, { recursive: true, force: true });
}
