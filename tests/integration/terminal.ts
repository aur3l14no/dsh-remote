import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { MockAdapter } from '@dsh-test/mock-adapter';
import WorldAgentRegistry from '../../packages/dsh-ssh/src/agents.ts';
import WorldToolRuntime from '../../packages/dsh-ssh/src/tools.ts';
import WorldSessionPersistence from '../../packages/dsh-ssh/src/persistence.ts';
import type SshSubprocess from '../../packages/dsh-ssh/src/subprocess.ts';
import { SshTerminal } from '../../packages/dsh-ssh/src/terminal.ts';
import { RemoteProcess } from '../../packages/client/src/index.ts';
import { runtime, fixture as nativeFixture } from '../client/support.ts';
import { remoteRuntime } from './remote-runtime.ts';

const ssh = !!process.env.DSH_TEST_HOST;
const fixture = ssh ? process.env.DSH_TEST_REMOTE_FIXTURE : nativeFixture;
const rg = process.env.DSH_TEST_RG ? resolve(process.env.DSH_TEST_RG) : undefined;
assert.ok(fixture && rg, 'Explicit local and target artifacts required');
const local = await mkdtemp('/tmp/dsh-terminal-local.');
const oldExecPath = process.execPath, oldPkg = Reflect.get(process, 'pkg');
const r = ssh ? await remoteRuntime('terminal-world') : await runtime({ world: 'terminal-world', lease: 5000 });
const contexts: Context[] = [];
const shell = process.env.DSH_TEST_TERMINAL_SHELL;
const deadline = setTimeout(() => { throw new Error('Terminal acceptance exceeded 120 seconds'); }, 120000);
async function harness(terminal?: { shell: string }) {
  const ctx = new Context(); contexts.push(ctx);
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt]) await ctx.plugin(plugin);
  await ctx.plugin(WorldToolRuntime, { mode: 'native' });
  await ctx.plugin(WorldAgentRegistry, { terminal, worlds: [{ id: 'terminal-world', target: 'acceptance-target', cwd: r.dir,
    open: async () => ({ client: r.client, ripgrep: ('ripgrep' in r ? r.ripgrep : ssh ? process.env.DSH_TEST_REMOTE_RG : rg)!, close: async () => {} }) }] });
  await ctx.plugin(WorldSessionPersistence, { root: `${local}/sessions` });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]));
  return ctx;
}
async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i++) { if (await test()) return; await delay(20); }
  throw new Error('Expected observation did not arrive');
}
const call = (agent: Agent, name: string, args: unknown) => agent.ctx.tools.execute({ name, arguments: args, agent,
  callId: ToolCallId(crypto.randomUUID()), signal: AbortSignal.timeout(15000) });
async function ok(agent: Agent, name: string, args: unknown) {
  const result = await call(agent, name, args);
  assert.notEqual(result.isError, true, JSON.stringify(result)); return result;
}
try {
  process.execPath = `${local}/harness`; Reflect.set(process, 'pkg', {}); await copyFile(rg, `${process.execPath}-rg`);
  const ctx = await harness();
  const registry = ctx.agents as WorldAgentRegistry;
  const owner = await ctx.agents.create({ sessionId: SessionId('primitive'), world: 'terminal-world' });
  const scope = registry.scopeFor(owner.agent), subprocess = scope.subprocess as SshSubprocess;
  const spec = { argv: [fixture, 'pty'], cwd: r.dir, rows: 24, cols: 80, graceMs: 1000 };
  await assert.rejects(subprocess.spawnTerminal({ ...spec, signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(subprocess.spawnTerminal({ ...spec, rows: 0 }), { code: 'INVALID_ARGUMENT' });
  const allocationSignal = new AbortController();
  const tty = await subprocess.spawnTerminal({ ...spec, signal: allocationSignal.signal });
  allocationSignal.abort(); // A published terminal owns its later lifetime.
  let text = '';
  const received = (async () => { for await (const bytes of tty.output) text += String(bytes); })();
  await until(() => text.includes('TTY 1 24 80'));
  assert.deepEqual(await tty.inspectForeground(), { processGroupId: tty.pid, inputWaiting: false });
  await tty.resize(41, 97); await tty.write('size\n');
  await until(() => text.includes('SIZE 41 97'));
  const epoch = r.client.info.runtime;
  r.client.reconnect(); await tty.write('once\n'); await r.client.whenReady();
  await until(() => text.includes('INPUT'));
  assert.equal(r.client.info.runtime, epoch);
  assert.equal(text.match(/INPUT/g)?.length, 1);
  await tty.write('quit\n'); assert.equal((await tty.done).exitCode, 0); await received; await tty.terminate();
  await assert.rejects(tty.write('late'), { code: 'CLOSED' });
  console.log('PASS PTY allocation, target dimensions/resize, input, final bytes and same-runtime reconnect');

  const blockedMarker = `${r.dir}/input-blocker`;
  const blocked = await subprocess.spawnTerminal({ ...spec, argv: [fixture, 'hold', 'ignore', blockedMarker] });
  await until(async () => !!await scope.fs.stat(await scope.fs.resolve(blockedMarker)));
  // Complete canonical lines fill unread terminal input; one overlong line would be discarded.
  const writing = blocked.write('x\n'.repeat(256 * 1024)).then(() => 'written', () => 'cancelled');
  await delay(100);
  r.client.reconnect();
  await blocked.terminate();
  assert.equal(await writing, 'cancelled');
  assert.equal((await blocked.done).signal, 'SIGKILL');
  await blocked.dispose();
  console.log('PASS terminate during reconnect cancels blocked input, awaits operations and confirms observed-session cleanup');

  const marker = `${r.dir}/burst-complete`;
  const slow = await subprocess.spawnTerminal({ ...spec, argv: [fixture, 'burst', '400000', marker] });
  await delay(200);
  assert.equal(await scope.fs.stat(await scope.fs.resolve(marker)), undefined, 'Unconsumed raw output must backpressure the child');
  const delivered: Buffer[] = [];
  for await (const chunk of slow.output) delivered.push(chunk);
  assert.equal((await slow.done).exitCode, 0);
  const expected = Buffer.from(Array.from({ length: 400000 }, (_, i) => (i % 8192) % 251).flatMap(byte => byte === 10 ? [13, 10] : [byte]));
  assert.deepEqual(Buffer.concat(delivered), expected, 'Default PTY ONLCR is the only output transformation');
  assert.equal(await scope.fs.readText(await scope.fs.resolve(marker)), 'complete');
  await slow.terminate();
  console.log('PASS bounded raw PTY backpressure and complete delivery after reader resumes');

  // Stop after the root exits while a still-observable descendant retains the PTY.
  const tree = await subprocess.spawnTerminal({ ...spec, argv: [fixture, 'tree', `${r.dir}/descendant`] });
  tree.output.resume();
  assert.equal((await tree.done).exitCode, 0);
  await tree.terminate(); await tree.dispose();
  // Gate allocation response to deterministically abort after helper admission.
  const originalRequest = r.client.request.bind(r.client);
  const admitted = Promise.withResolvers<void>(), publish = Promise.withResolvers<void>();
  r.client.request = async <T>(...args: Parameters<typeof originalRequest>): Promise<T> => {
    const result = await originalRequest<T>(...args);
    if (args[0] === 'process.spawn') { admitted.resolve(); await publish.promise; }
    return result;
  };
  const abort = new AbortController();
  const late = subprocess.spawnTerminal({ ...spec, signal: abort.signal });
  await admitted.promise; abort.abort(); publish.resolve();
  await assert.rejects(late, { code: 'CANCELLED' });
  r.client.request = originalRequest;
  for (let i = 0; i < 18; i++) {
    const t = await subprocess.spawnTerminal({ ...spec, argv: ['sh', '-c', 'exit 0'] });
    for await (const _ of t.output) { /* drain */ }
    await t.done; await t.dispose();
  }
  const abandoned = await subprocess.spawnTerminal({ ...spec, argv: [fixture, 'burst', '400000'] });
  await owner.dispose(); await abandoned.done;
  console.log('PASS post-root-exit cleanup, late allocation cancellation, process-slot reuse and unread-output owner disposal');

  const missing = await harness({ shell: '/dsh-acceptance-missing-bash' });
  await assert.rejects(missing.agents.create({ sessionId: SessionId('missing-shell'), world: 'terminal-world' }), { code: 'NOT_FOUND' });
  assert.equal(missing.agents.get(SessionId('missing-shell')), undefined);
  await missing.fiber.dispose();
  console.log('PASS absent target shell refuses Agent publication without local fallback');

  if (shell) {
    const app = await harness({ shell }), agents = app.agents as WorldAgentRegistry;
    const a = await app.agents.create({ sessionId: SessionId('terminal-owner'), world: 'terminal-world' });
    const b = await app.agents.create({ sessionId: SessionId('terminal-peer'), world: 'terminal-world' });
    let consumer!: Context;
    await agents.scopeFor(a.agent).plugin({ inject: ['terminals', 'jobs'], apply(c: Context) { consumer = c; } });
    await ok(a.agent, 'terminal_open', { type: 'shell', name: 'main' });
    const id = consumer.terminals.list(a.agent)[0]!.sessionId;
    const result = await ok(a.agent, 'terminal_send', { sessionId: id, text: "printf 'remote-terminal✓\\n'; printf world > terminal-marker" });
    assert.ok(JSON.stringify(result).includes('remote-terminal✓'));
    assert.equal(await agents.scopeFor(a.agent).fs.readText(await agents.scopeFor(a.agent).fs.resolve('terminal-marker')), 'world');
    if (ssh) await assert.rejects(readFile(`${r.dir}/terminal-marker`), { code: 'ENOENT' });
    assert.equal((await call(b.agent, 'terminal_send', { sessionId: id, text: 'echo forbidden' })).isError, true);
    await ok(a.agent, 'terminal_send', { sessionId: id, text: "sh -c 'while :; do echo tick; sleep 0.1; done'", run_in_background: true });
    const job = consumer.jobs.list(a.agent)[0]!;
    const ownedJobs = consumer.jobs;
    assert.equal(job.ownerSession, a.agent.id);
    await delay(300);
    await ok(a.agent, 'job_output', { job_id: job.id });
    await ok(a.agent, 'job_kill', { job_id: job.id });
    await until(() => consumer.jobs.get(job.id, a.agent).status === 'killed').catch(error => { throw new Error(JSON.stringify(consumer.jobs.read(job.id, a.agent)), { cause: error }); });
    await ok(a.agent, 'terminal_send', { sessionId: id, text: "printf 'after-interrupt\\n'" });
    console.log('PASS actual terminal tools and Session jobs: target execution, owner isolation, background output and foreground cancellation');

    await ok(a.agent, 'terminal_send', { sessionId: id, text: "sh -c 'while :; do echo tick; sleep 0.1; done'", run_in_background: true });
    await ok(b.agent, 'terminal_open', { type: 'shell' });
    let peerConsumer!: Context;
    await agents.scopeFor(b.agent).plugin({ inject: ['terminals'], apply(c: Context) { peerConsumer = c; } });
    const peerId = peerConsumer.terminals.list(b.agent)[0]!.sessionId;
    r.client.reconnect(); await a.dispose();
    assert.equal(ownedJobs.list(a.agent).length, 0);
    assert.equal(r.client.state, 'ready');
    await ok(b.agent, 'terminal_list', {});
    const final = await ok(b.agent, 'terminal_send', { sessionId: peerId, text: "printf 'terminal-final\\n'; exit 7" });
    assert.ok(JSON.stringify(final).includes('terminal-final'));
    await until(() => peerConsumer.terminals.list(b.agent)[0]!.status.kind === 'exited');
    await b.dispose();
    console.log('PASS Agent teardown during reconnect cancels its terminal/job while a peer World owner survives');
  } else {
    await assert.rejects(r.client.requestWhenReady('process.resolveExecutable', { command: 'bash', cwd: r.dir }), { code: 'NOT_FOUND' });
    console.log('PASS Bash consumer unavailable on target; portable PTY primitive remains supported');
  }
  if (!ssh) {
    const fault = await runtime({ grace: 500 });
    try {
      const process = await RemoteProcess.spawn(fault.client, { mode: 'pty', argv: ['sh', '-c', 'sleep 2'], cwd: fault.dir });
      const terminal = new SshTerminal(fault.client, process, () => {});
      const exitFailure = assert.rejects(terminal.done);
      const outputFailure = assert.rejects(async () => { for await (const _ of terminal.output) { /* drain */ } });
      fault.child.kill('SIGKILL');
      await Promise.all([exitFailure, outputFailure]);
      await assert.rejects(terminal.terminate());
      await assert.rejects(terminal.write('must-not-run'), { code: 'CLOSED' });
      assert.equal(fault.client.state, 'failed');
      console.log('PASS permanent helper loss rejects terminal exit/output and leaves cleanup unconfirmed');
    } finally { await fault.close(); }
  }
} finally {
  clearTimeout(deadline);
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
  await r.close(); process.execPath = oldExecPath;
  if (oldPkg === undefined) Reflect.deleteProperty(process, 'pkg'); else Reflect.set(process, 'pkg', oldPkg);
  await rm(local, { recursive: true, force: true });
}
