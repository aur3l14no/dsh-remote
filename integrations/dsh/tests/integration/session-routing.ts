/** Real DSH JSONL + external World sidecar, exercised across separate harness processes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets, { serviceForAgent } from '@deepseek-ai/dsh-agent-presets';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver';
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-test/mock-adapter';
import { BindingStore } from '../../packages/world/execution-world/src/bindings.ts';
import type { SshWorkspaceDefinition } from '../../packages/world/execution-world/src/identity.ts';
import ExecutionWorlds, { executionWorldsPlugin } from '../../packages/world/execution-world/src/worlds.ts';
import * as Routing from '../../packages/world/execution-world/src/routing.ts';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
import { runtime, fixture } from '../../../../runtime/tests/client/support.ts';

const ssh = !!process.env.DSH_TEST_HOST;
const packaged = process.env.DSH_TEST_PACKAGED === '1';
const phase = process.argv[2];
if (!phase) {
  const base = await mkdtemp(packaged ? new URL('state-', import.meta.url).pathname : '/tmp/dsh-durable-routing.');
  const control = sshControl({ host: process.env.DSH_TEST_HOST!, configFile: process.env.DSH_TEST_SSH_CONFIG,
    podmanContainer: process.env.DSH_TEST_PODMAN_CONTAINER });
  let workspaceRoot = `${base}/workspaces`;
  try {
    if (ssh) {
      workspaceRoot = (await control(['mktemp', '-d', '/tmp/dsh-routing.XXXXXXXX'])).trim();
      assert.match(workspaceRoot, /^\/tmp\/dsh-routing\.[A-Za-z0-9]{8}$/);
      await control(['mkdir', `${workspaceRoot}/a`, `${workspaceRoot}/b`]);
    } else {
      await mkdir(`${workspaceRoot}/a`, { recursive: true }); await mkdir(`${workspaceRoot}/b`);
      workspaceRoot = await realpath(workspaceRoot);
    }
    const definitions: SshWorkspaceDefinition[] = ['a', 'b'].map(id => ({ id: `route-${id}`, worldId: `environment-${id}`, kind: 'ssh',
      host: process.env.DSH_TEST_HOST ?? 'native-acceptance.invalid', cwd: `${workspaceRoot}/${id}`,
      ...(process.env.DSH_TEST_SSH_CONFIG ? { configFile: process.env.DSH_TEST_SSH_CONFIG } : {}),
      ...(process.env.DSH_TEST_PODMAN_CONTAINER ? { podmanContainer: process.env.DSH_TEST_PODMAN_CONTAINER } : {}),
      ...(ssh ? { installRoot: `${workspaceRoot}/artifacts`, runtimeBase: workspaceRoot } : {}) }));
    await writeFile(`${base}/definitions.json`, JSON.stringify(definitions), { mode: 0o600 });
    for (const stage of ['create', 'resume']) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), stage, base], { stdio: 'inherit', signal: AbortSignal.timeout(120000) });
      await new Promise<void>((accept, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? accept() : reject(new Error(`Routing ${stage} process exited ${code}`)));
      });
    }
    console.log('PASS separate harness processes restore DSH JSONL Sessions and World bindings without helper task replay');
  } finally {
    if (ssh && /^\/tmp\/dsh-routing\.[A-Za-z0-9]{8}$/.test(workspaceRoot)) {
      await control(['chmod', '-R', 'u+w', workspaceRoot]); await control(['rm', '-r', workspaceRoot]);
    }
    await rm(base, { recursive: true, force: true });
  }
} else {
  const base = process.argv[3]!;
  const definitions: SshWorkspaceDefinition[] = JSON.parse(await readFile(`${base}/definitions.json`, 'utf8'));
  const bindingFile = `${base}/bindings.json`;
  if (phase === 'create') BindingStore.create(bindingFile);
  const originalExecPath = process.execPath, originalPkg = Reflect.get(process, 'pkg');
  const ctx = new Context();
  const rg = resolve(process.env.DSH_TEST_RG!);
  let connected = 0;
  try {
    if (process.env.DSH_TEST_RG_MODE !== 'npm') {
      process.execPath = `${base}/harness`; Reflect.set(process, 'pkg', {});
      await copyFile(rg, `${process.execPath}-rg`);
    }
    const packagedRipgrep = await SearchTools.resolveRgPath();
    if (process.env.DSH_TEST_RG_MODE === 'npm') {
      assert.equal(packagedRipgrep, (await import('@vscode/ripgrep')).rgPath);
      assert.ok(fs.existsSync(packagedRipgrep));
    }
    ctx.baseUrl = pathToFileURL(`${base}/`).href;
    await ctx.plugin(Loader);
    ctx.loader.builtins = { include: Include, group: Group, fs: Routing.RoutedFileSystem, subprocess: Routing.RoutedSubprocess,
      routing: Routing, files: FileTools, search: SearchTools };
    for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, AgentRegistry, SessionProjectionRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(JsonlPersistence, { root: `${base}/sessions`, compression: 'none' });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    // Only native acceptance injects a resolver. SSH exercises the normal bootstrap entry point.
    const provider = ssh ? ExecutionWorlds : executionWorldsPlugin(async definition => {
      connected++;
      const r = await runtime({ world: definition.id, lease: 5000 });
      return { client: r.client, ripgrep: rg, close: () => r.close() };
    });
    const manifest = ssh ? JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')) : {};
    const worldConfig = { bindingFile, packagedRipgrep, bootstrap: { manifest,
      cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE ?? base, graceMs: 15000, leaseMs: 5000 } };
    if (packaged && ssh) {
      await ctx.loader.create({ name: '@dsh-remote/ssh-world', config: worldConfig });
      await ctx.loader.await();
    } else await ctx.plugin(provider, worldConfig);
    await ctx.plugin(AgentLoop, { agents: [] });
    await mkdir(`${base}/shared`, { recursive: true });
    await writeFile(`${base}/shared/agent.cordis.yml`, JSON.stringify([
      { id: 'world-routing', name: 'cordis:group', isolate: { fs: true, subprocess: true }, config: [
        { id: 'fs', name: packaged ? '@dsh-remote/ssh-world/fs' : 'cordis:fs' },
        { id: 'subprocess', name: packaged ? '@dsh-remote/ssh-world/subprocess' : 'cordis:subprocess' },
        { id: 'routing', name: packaged ? '@dsh-remote/ssh-world/routing' : 'cordis:routing' }, { id: 'files', name: 'cordis:files' },
        { id: 'search', name: 'cordis:search', config: { sampleOverCapGlobResults: false } },
      ] },
    ]));
    await ctx.plugin(AgentPresets, { default: 'shared', roots: [{ path: base, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
    const adapter = new MockAdapter([toolCallResponse('child-read', 'read', { file_path: 'sentinel.txt' }), textResponse('child done')]);
    ctx.llm.registerAdapter(['mock'], adapter);
    const worlds = ctx.executionWorlds;
    const setup = async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, 'shared'); };
    const create = (id: string, definition: SshWorkspaceDefinition) => ctx.agents.create({ sessionId: SessionId(id),
      meta: { cwd: definition.cwd, agentPreset: 'shared' }, agentOptions: { provider: 'mock', model: 'mock' }, setup });
    let call = 0;
    const execute = (agent: Agent | undefined, name: string, args: Record<string, unknown>) => ctx.tools.execute({
      agent, name, arguments: args, callId: ToolCallId(`routing-${call++}`), signal: AbortSignal.timeout(10000),
    });
    if (phase === 'create') {
      await Promise.all(definitions.map((definition, i) => worlds.bind(i ? 'b' : 'a', definition)));
      const a = await create('a', definitions[0]!), b = await create('b', definitions[1]!);
      const fsService = serviceForAgent(ctx, a.agent, 'fs')!;
      assert.equal(fsService, serviceForAgent(ctx, b.agent, 'fs'));
      assert.equal(serviceForAgent(ctx, a.agent, 'subprocess'), serviceForAgent(ctx, b.agent, 'subprocess'));
      assert.equal(ctx.tools.get('read', a.agent), ctx.tools.get('read', b.agent));
      assert.throws(() => fsService.resolve('sentinel.txt'), { code: 'WORLD_REQUIRED' });
      for (const agent of [a.agent, b.agent]) {
        const concrete = worlds.forAgent(agent);
        assert.equal(concrete.remoteWorkspace.client.info.world, worlds.bindings.get(agent.id)!.worldId);
        await concrete.fs.writeText(await concrete.fs.resolve('sentinel.txt'), `${worlds.bindings.get(agent.id)!.id}\n`);
      }
      const approvals: ReturnType<typeof Routing.executionWorldContext>[] = [];
      ctx.on('tools/pre-execute', async (exec, next) => { approvals.push(Routing.executionWorldContext(ctx, exec)); return next(); });
      await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        const agent = i % 2 ? a.agent : b.agent, expected = i % 2 ? 'route-a' : 'route-b';
        const name = i % 4 < 2 ? 'read' : 'grep';
        const result = await execute(agent, name, name === 'read' ? { file_path: 'sentinel.txt' } : { pattern: 'route', path: 'sentinel.txt' });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.ok(JSON.stringify(result).includes(expected));
        assert.ok(!JSON.stringify(result).includes(expected === 'route-a' ? 'route-b' : 'route-a'));
      }));
      assert.deepEqual(new Set(approvals.map(facts => `${facts.world}:${facts.workspace}:${facts.kind}`)),
        new Set(['environment-a:route-a:ssh', 'environment-b:route-b:ssh']));
      console.log('PASS persistent bindings route concurrent real DSH FS/search and approval context under one preset');

      const child = await startInProcessRun({ parent: a.agent, prompt: [{ type: 'text', text: 'Read the bound World' }],
        signal: AbortSignal.timeout(10000), toolFilter: { allow: ['read'] }, descriptor: { version: 1, mode: 'one-shot', provider: 'in-process' } }, {});
      assert.equal((await child.result).stopReason, 'completed');
      const childId = child.localAgent!.session.header.id;
      assert.deepEqual(new BindingStore(bindingFile).get(childId), definitions[0]);
      assert.equal(serviceForAgent(ctx, child.localAgent!, 'fs'), fsService);
      assert.deepEqual(ctx.tools.schemas(child.localAgent).map(t => t.name), ['read']);
      assert.ok(JSON.stringify(child.localAgent!.session.snapshotEvents()).includes('route-a'));
      const modelRequest = JSON.stringify(adapter.requests[0]);
      assert.ok(modelRequest.includes(worlds.forAgent(a.agent).remoteWorkspace.client.info.runtime));
      for (const fact of ['"world":"environment-a"', '"workspace":"route-a"', '"kind":"ssh"']) {
        assert.ok(modelRequest.includes(JSON.stringify(fact).slice(1, -1)), `Model context is missing ${fact}`);
      }
      await child.dispose();
      console.log('PASS unchanged DSH child persists its World identity before execution and keeps native filtering');

      const childMeta = { cwd: definitions[0]!.cwd, parentSession: a.agent.session.header.id, origin: 'subagent' as const, agentPreset: 'shared' };
      await assert.rejects(ctx.agents.create({ sessionId: SessionId('rollback-child'), meta: childMeta,
        setup: async agentCtx => { await setup(agentCtx); agentCtx.on('agent/created', () => { throw new Error('injected publication failure'); }); } }), /injected publication failure/);
      assert.equal(worlds.bindings.get('rollback-child'), undefined);
      await assert.rejects(create('unbound', definitions[0]!), { code: 'WORLD_REQUIRED' });
      assert.equal((await execute(undefined, 'read', { file_path: 'sentinel.txt' })).isError, true);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { if (to === bindingFile) throw new Error('injected binding write failure'); return rename(from, to); };
      try {
        // DSH contains session-start observer failures; verify admission remains closed.
        const blocked = await ctx.agents.create({ sessionId: SessionId('failed-child'), meta: childMeta, setup });
        assert.equal(worlds.bindings.get('failed-child'), undefined);
        assert.throws(() => worlds.forAgent(blocked.agent), { code: 'WORLD_REQUIRED' });
        assert.equal((await execute(blocked.agent, 'read', { file_path: 'sentinel.txt' })).isError, true);
        await blocked.dispose();
      } finally { fs.renameSync = rename; }
      console.log('PASS publication rollback and binding write failure admit no unbound tool execution');

      const concrete = worlds.forAgent(a.agent);
      const targetFixture = ssh ? process.env.DSH_TEST_REMOTE_FIXTURE : fixture;
      assert.ok(targetFixture, 'Explicit target-native acceptance fixture required');
      const once = concrete.subprocess.spawn({ argv: [targetFixture, 'append', `${definitions[0]!.cwd}/executed.txt`], cwd: definitions[0]!.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
      assert.equal((await once.done).exitCode, 0, once.collected.stderr!.readFrom(0).text); await once.waitForExit();
      await writeFile(`${base}/proof.json`, JSON.stringify({ childId, runtime: concrete.remoteWorkspace.client.info.runtime }));
      await ctx.sessionPersistence.flush();
      await b.dispose(); await a.dispose();
    } else {
      const proof = JSON.parse(await readFile(`${base}/proof.json`, 'utf8'));
      await assert.rejects(worlds.prepare('missing-session'), { code: 'WORLD_REQUIRED' });
      await assert.rejects(worlds.bind('a', { ...definitions[0]!, host: 'changed.invalid' }), { code: 'WORLD_MISMATCH' });
      assert.equal(connected, 0);
      await worlds.prepare('a');
      const a = await ctx.agents.resume({ resumeSessionId: SessionId('a'), setup });
      const concrete = worlds.forAgent(a.agent);
      assert.notEqual(concrete.remoteWorkspace.client.info.runtime, proof.runtime);
      assert.equal((await execute(a.agent, 'read', { file_path: 'sentinel.txt' })).isError, false);
      assert.equal(await concrete.fs.readText(await concrete.fs.resolve('executed.txt')), 'once\n');
      await worlds.prepare(proof.childId);
      const child = await ctx.agents.resume({ resumeSessionId: SessionId(proof.childId), setup });
      const childFacts = Routing.executionWorldContext(ctx, child.agent);
      assert.deepEqual([childFacts.world, childFacts.workspace, childFacts.kind], ['environment-a', 'route-a', 'ssh']);
      assert.ok(JSON.stringify(child.agent.session.snapshotEvents()).includes('route-a'));
      assert.equal((await execute(child.agent, 'read', { file_path: 'sentinel.txt' })).isError, false);
      await child.dispose();
      // Losing a saved child row must not silently reconstruct it from parent lineage on resume.
      const data = JSON.parse(await readFile(bindingFile, 'utf8'));
      data.sessions = data.sessions.filter((entry: { sessionId: string }) => entry.sessionId !== proof.childId);
      await writeFile(bindingFile, JSON.stringify(data), { mode: 0o600 });
      await assert.rejects(worlds.prepare(proof.childId), { code: 'WORLD_REQUIRED' });
      const missing = await ctx.agents.resume({ resumeSessionId: SessionId(proof.childId), setup });
      assert.equal(worlds.bindings.get(proof.childId), undefined);
      assert.equal((await execute(missing.agent, 'read', { file_path: 'sentinel.txt' })).isError, true);
      await missing.dispose();
      await a.dispose();
      console.log('PASS real DSH JSONL resume restores World identity into a new runtime and refuses missing or changed bindings');
    }
  } finally {
    await ctx.fiber.dispose();
    process.execPath = originalExecPath;
    if (originalPkg === undefined) Reflect.deleteProperty(process, 'pkg'); else Reflect.set(process, 'pkg', originalPkg);
  }
}
