import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver';
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-test/mock-adapter';
import { worldContextFor } from '../../plugins/ssh-world/src/context.ts';
import { runtime } from '../../../../runtime/tests/client/support.ts';
import { remoteRuntime } from './remote-runtime.ts';
import { presetHarness, serviceForAgent } from './preset-harness.ts';

const ssh = !!process.env.DSH_TEST_HOST;
const rg = resolve(process.env.DSH_TEST_RG!);
const local = await mkdtemp('/tmp/dsh-preset-local.');
const execPath = process.execPath, pkg = Reflect.get(process, 'pkg');
const runtimes = await Promise.all(['world-a', 'world-b'].map(world => ssh ? remoteRuntime(world) : runtime({ world, lease: 5000 })));
let ctx: Awaited<ReturnType<typeof presetHarness>> | undefined;
try {
  process.execPath = `${local}/harness`; Reflect.set(process, 'pkg', {}); await copyFile(rg, `${process.execPath}-rg`);
  ctx = await presetHarness(`${local}/presets`, runtimes.map((r, i) => ({ id: i ? 'world-b' : 'world-a', client: r.client,
    ripgrep: ('ripgrep' in r ? r.ripgrep : ssh ? process.env.DSH_TEST_REMOTE_RG : rg)! })));
  const adapter = new MockAdapter([
    toolCallResponse('parent-read', 'read', { file_path: 'sentinel.txt' }), textResponse('parent done'),
    toolCallResponse('child-read', 'read', { file_path: 'sentinel.txt' }), textResponse('child done'),
    textResponse('deny done'), textResponse('empty done'),
  ]);
  ctx.llm.registerAdapter(['mock'], adapter);
  const parent = await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd: runtimes[0]!.dir, agentPreset: 'world-a' },
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async c => { await ctx!.agentPresets.mount(c, 'world-a'); } });
  const fs = serviceForAgent(ctx, parent.agent, 'fs')!;
  await fs.writeText(await fs.resolve('sentinel.txt'), 'remote-only\n');
  if (ssh) await assert.rejects(readFile(`${runtimes[0]!.dir}/sentinel.txt`), { code: 'ENOENT' });
  const toolsBefore = ctx.tools.schemas(parent.agent);
  assert.equal(ctx.get('fs'), undefined);
  const approvals: string[] = [];
  ctx.on('tools/pre-execute', async (exec, next) => { approvals.push(worldContextFor(ctx!, exec).world); return next(); });
  parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the workspace' }], source: { kind: 'user' } }));
  await parent.agent.whenIdle();
  assert.ok(JSON.stringify(parent.agent.session.snapshotEvents()).includes('remote-only'));
  assert.ok(JSON.stringify(adapter.requests[0]).includes(runtimes[0]!.client.info.runtime));
  console.log('PASS actual DSH preset mounts World providers/tools once and supplies model/approval context');

  const child = await startInProcessRun({ parent: parent.agent, prompt: [{ type: 'text', text: 'Read the same World' }],
    signal: AbortSignal.timeout(10000), toolFilter: { allow: ['read'] }, descriptor: { version: 1, mode: 'one-shot', provider: 'in-process' } }, {});
  assert.equal((await child.result).stopReason, 'completed');
  assert.equal(worldContextFor(ctx, child.localAgent!).runtime, worldContextFor(ctx, parent.agent).runtime);
  assert.equal(serviceForAgent(ctx, child.localAgent!, 'subprocess'), serviceForAgent(ctx, parent.agent, 'subprocess'));
  assert.deepEqual(ctx.tools.schemas(child.localAgent).map(t => t.name), ['read']);
  assert.deepEqual(ctx.tools.schemas(child.localAgent)[0], toolsBefore.find(t => t.name === 'read'));
  assert.equal(ctx.tools.get('read', child.localAgent), ctx.tools.get('read', parent.agent));
  assert.ok(JSON.stringify(child.localAgent!.session.snapshotEvents()).includes('remote-only'));
  await child.dispose();
  for (const filter of [{ deny: ['read'] }, { allow: [] }]) {
    const run = await startInProcessRun({ parent: parent.agent, prompt: [{ type: 'text', text: 'Use your available tools' }],
      signal: AbortSignal.timeout(10000), toolFilter: filter, descriptor: { version: 1, mode: 'one-shot', provider: 'in-process' } }, {});
    assert.equal((await run.result).stopReason, 'completed');
    const names: string[] = ctx.tools.schemas(run.localAgent).map(t => t.name);
    assert.ok(!names.includes('read'));
    if ('allow' in filter) assert.deepEqual(names, []);
    assert.equal(worldContextFor(ctx, run.localAgent!).runtime, runtimes[0]!.client.info.runtime);
    await run.dispose();
  }
  assert.deepEqual(ctx.tools.schemas(parent.agent), toolsBefore);
  assert.ok(approvals.every(world => world === 'world-a'));
  console.log('PASS DSH subagent driver inherits the same World and unmodified allow/deny/empty filters work');

  const other = await ctx.agents.create({ sessionId: SessionId('other'), meta: { cwd: runtimes[1]!.dir, agentPreset: 'world-b' },
    setup: async c => { await ctx!.agentPresets.mount(c, 'world-b'); } });
  assert.notEqual(worldContextFor(ctx, other.agent).runtime, worldContextFor(ctx, parent.agent).runtime);
  const otherFs = serviceForAgent(ctx, other.agent, 'fs')!;
  assert.equal(await otherFs.stat(await otherFs.resolve('sentinel.txt')), undefined);
  const native = realpathSync.native;
  let localResolutions = 0;
  realpathSync.native = (() => { localResolutions++; throw new Error('local realpath trap'); }) as typeof native;
  try {
    const blocked = await parent.agent.ctx.tools.execute({ name: 'read', arguments: { file_path: '../sentinel.txt' }, agent: parent.agent,
      callId: ToolCallId('parent-path'), signal: AbortSignal.timeout(5000) });
    assert.equal(blocked.isError, true); assert.equal(localResolutions, 0);
    assert.ok(JSON.stringify(blocked).includes('upstream'));
  } finally { realpathSync.native = native; }
  await assert.rejects(ctx.agents.create({ sessionId: SessionId('bad-cwd'), meta: { cwd: '/wrong-world-cwd' },
    setup: async c => { await ctx!.agentPresets.mount(c, 'world-a'); } }), { code: 'WORLD_MISMATCH' });
  assert.equal(ctx.agents.get(SessionId('bad-cwd')), undefined);
  const blank = await ctx.agents.create({ sessionId: SessionId('blank'), meta: { cwd: runtimes[0]!.dir },
    setup: async c => { await ctx!.agentPresets.mount(c, 'world-a'); } });
  await ctx.agentPresets.recompose(blank.agent.ctx, 'world-b');
  assert.throws(() => worldContextFor(ctx!, blank.agent), { code: 'WORLD_MISMATCH' });
  await blank.dispose();
  await other.dispose(); await parent.dispose();
  console.log('PASS separate Worlds, publication cwd validation, changed World refusal and upstream local-realpath bypass rejection');
} finally {
  await ctx?.fiber.dispose();
  for (const r of runtimes) await r.close();
  process.execPath = execPath;
  if (pkg === undefined) Reflect.deleteProperty(process, 'pkg'); else Reflect.set(process, 'pkg', pkg);
  await rm(local, { recursive: true, force: true });
}
