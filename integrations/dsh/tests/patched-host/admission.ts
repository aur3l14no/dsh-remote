import * as NativeWorkspaces from '../../packages/workspace/local-workspace/src/native.ts';
/** Patched native Web admission, using real Agent/Session services and native or real SSH helper fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets, { serviceForAgent } from '@deepseek-ai/dsh-agent-presets';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { ApiSessionAgentController } from '@dsh-test/web-agent';
import { SessionCommandController } from '@dsh-test/web-commands';
import { installModelSelectionProjection } from '@dsh-test/web-model-selection-projection';
import { BindingStore } from '../../packages/world/execution-world/src/bindings.ts';
import ExecutionWorlds, { executionWorldsPlugin } from '../../packages/world/execution-world/src/worlds.ts';
import * as Routing from '../../packages/world/execution-world/src/routing.ts';
import PortableWorkspaces, { type CatalogWorld } from '../../packages/workspace/portable-workspace/src/registry.ts';
import * as Admission from '../../packages/workspace/portable-workspace/src/admission.ts';
import { PortableWorkspaceFeed } from '../../packages/workspace/portable-workspace/src/api.ts';
import { runtime } from '../../../../runtime/tests/client/support.ts';

const phase = process.argv[2];
const ssh = Boolean(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG);
const markerFor = (index: number) => ssh ? `world-${index}` : 'native-shared-directory';
interface Selection { worlds: CatalogWorld[]; path: string }
interface Saved { portableWorkspaceIds: string[]; sessionIds: string[]; runtimeIds: string[] }
if (!phase) {
  const base = await mkdtemp('/tmp/dsh-portable_workspace-experiment.');
  try {
    await mkdir(`${base}/workspace`);
    const selection: Selection = ssh ? JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG!, 'utf8')) : { worlds: ['a', 'b'].map(id => ({ id, name: `World ${id}`, target: { kind: 'ssh', host: 'native-acceptance.invalid' } })),
      path: await realpath(`${base}/workspace`) };
    assert.equal(selection.worlds.length, 2, 'Acceptance requires two configured Worlds');
    await writeFile(`${base}/selection.json`, JSON.stringify(selection), { mode: 0o600 });
    BindingStore.create(`${base}/bindings.json`);
    for (const phase of ['create', 'resume', 'observed-resume', 'lookup-resume', 'retired', 'changed', 'unavailable', 'unbound', 'local-create', 'local-resume']) {
      if (ssh && phase === 'unavailable') {
        console.log('SKIP native transport fault injection; real SSH disconnection is not covered by this fixture');
        continue;
      }
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, base],
        { stdio: 'inherit', signal: AbortSignal.timeout(180000) });
      await new Promise<void>((accept, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? accept() : reject(new Error(`PortableWorkspace ${phase} phase exited ${code}`)));
      });
    }
    console.log('PASS PortableWorkspace metadata and native JSONL survive separate host processes; no helper runtime is restored');
  } finally { await rm(base, { recursive: true, force: true }); }
} else {
  const base = process.argv[3]!;
  const selection: Selection = JSON.parse(await readFile(`${base}/selection.json`, 'utf8'));
  const ctx = new Context();
  let connections = 0;
  const rg = ssh ? '' : resolve(process.env.DSH_TEST_RG!);
  try {
    ctx.baseUrl = pathToFileURL(`${base}/`).href;
    await ctx.plugin(Loader);
    ctx.loader.builtins = { include: Include, group: Group, fs: Routing.RoutedFileSystem,
      subprocess: Routing.RoutedSubprocess, routing: Routing, files: FileTools };
    for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, AgentRegistry, SessionProjectionRegistry, Storage, TypertRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(JsonlPersistence, { root: `${base}/sessions`, compression: 'none' });
    await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' });
    await ctx.plugin(JsonStorage, { root: `${base}/portableWorkspaces` });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' });
    installModelSelectionProjection(ctx);
    const provider = ssh ? ExecutionWorlds : executionWorldsPlugin(async definition => {
      connections++;
      if (phase === 'unavailable') throw new Error('Selected World transport is unavailable');
      const r = await runtime({ world: definition.id, lease: 5000 });
      return { client: r.client, ripgrep: rg, close: () => r.close() };
    });
    await ctx.plugin(provider, { bindingFile: `${base}/bindings.json`, packagedRipgrep: await SearchTools.resolveRgPath(),
      bootstrap: { manifest: ssh ? JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')) : {}, cacheDir: ssh ? process.env.DSH_TEST_ARTIFACT_CACHE! : base, graceMs: 15000, leaseMs: 5000 } });
    await ctx.plugin(AgentLoop, { agents: [] });
    await mkdir(`${base}/remote`, { recursive: true });
    await writeFile(`${base}/remote/agent.cordis.yml`, JSON.stringify(phase.startsWith('local-') ? [] : [
      { id: 'world-routing', name: 'cordis:group', isolate: { fs: true, subprocess: true }, config: [
        { name: 'cordis:fs' }, { name: 'cordis:subprocess' }, { name: 'cordis:routing' }, { name: 'cordis:files' },
      ] },
    ]));
    await ctx.plugin(AgentPresets, { default: 'remote', roots: [{ path: base, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
    const configured = structuredClone(selection.worlds);
    if (phase === 'retired') configured.splice(0, 1);
    if (phase === 'changed') {
      assert.equal(configured[0]!.target.kind, 'ssh');
      configured[0]!.target = { ...configured[0]!.target, kind: 'ssh', host: 'changed-acceptance.invalid' };
    }
    await ctx.plugin(NativeWorkspaces);
    await ctx.plugin(PortableWorkspaces, { worlds: configured });
    assert.ok(ctx.workspaceRegistry instanceof PortableWorkspaces, 'The local Workspace registry must be replaced');
    const portableWorkspaces = ctx.worldPortableWorkspaces;
    if (!phase.startsWith('local-')) await ctx.plugin(Admission);
    // These are the patched native Web controllers, not replacement Agent factories.
    const apiAgents = new ApiSessionAgentController(ctx);
    const apiCommands = new SessionCommandController(ctx, apiAgents, base);
    const readMarker = async (sessionId: SessionId, marker: string) => {
      const result = await ctx.tools.execute({ agent: ctx.agents.get(sessionId), name: 'read',
        arguments: { file_path: 'portable_workspace-marker.txt' }, callId: ToolCallId(`portable_workspace-${sessionId}`), signal: AbortSignal.timeout(10000) });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(JSON.stringify(result).includes(marker));
    };
    if (phase.startsWith('local-')) {
      if (phase === 'local-create') {
        const cwd = `${base}/local-session`;
        const result = await apiCommands.create({ cwd, sessionId: SessionId('local-regression') });
        assert.ok((await stat(cwd)).isDirectory());
        assert.equal(result.sessionId, 'local-regression');
        await ctx.sessionPersistence.flush();
      } else {
        const result = await apiAgents.resolveAgent(SessionId('local-regression'));
        assert.ok('agent' in result);
        assert.equal(result.agent.session.header.cwd, `${base}/local-session`);
      }
      if (!ssh) assert.equal(connections, 0);
      assert.equal(ctx.executionWorlds.bindings.get('local-regression'), undefined);
      console.log(`PASS unconfigured host preserves native ${phase} without remote binding`);
    } else if (phase === 'create') {
      const a = await portableWorkspaces.createInWorld(selection.worlds[0]!.id, selection.path);
      const b = await portableWorkspaces.createInWorld(selection.worlds[1]!.id, selection.path);
      assert.equal(a.path, b.path); assert.notEqual(a.id, b.id);
      assert.equal((await portableWorkspaces.createInWorld(selection.worlds[0]!.id, `${selection.path}/.`)).id, a.id);
      await assert.rejects(portableWorkspaces.create(selection.path), { code: 'WORLD_REQUIRED' });
      await assert.rejects(portableWorkspaces.resolveByPath(selection.path), { code: 'WORLD_REQUIRED' });
      assert.equal(portableWorkspaces.list().length, 2);
      console.log('PASS two catalog Worlds with the same canonical workspace remain distinct PortableWorkspaces');
      const ids = await Promise.all([a, b].map(async portableWorkspace => (await apiCommands.create({ workspaceId: portableWorkspace.id })).sessionId));
      for (const [index, portableWorkspace] of [a, b].entries()) {
        const id = ids[index]!;
        const adopted = await apiCommands.create({ workspaceId: portableWorkspace.id, sessionId: id });
        assert.equal(adopted.sessionId, id);
        const resolved = await apiAgents.resolveAgent(id);
        assert.ok('agent' in resolved); assert.equal(resolved.agent.id, id);
        assert.deepEqual(portableWorkspace.sessionIds, [id]);
        const owner = ctx.executionWorlds.forAgent(ctx.agents.get(id));
        const marker = markerFor(index);
        await owner.fs.writeText(await owner.fs.resolve('portable_workspace-marker.txt'), marker);
      }
      for (const [index, id] of ids.entries()) await readMarker(id, markerFor(index));
      assert.equal(serviceForAgent(ctx, ctx.agents.get(ids[0]!)!, 'fs'), serviceForAgent(ctx, ctx.agents.get(ids[1]!)!, 'fs'));
      await assert.rejects(b.attachSession(ids[0]!), { code: 'WORLD_MISMATCH' });
      console.log('PASS patched Web creates and adopts bound Agents directly under one shared preset');
      const beforePin = a.updatedAt;
      const boundBeforePin = ctx.executionWorlds.bindings.get(ids[0]!);
      const feedSignal = new AbortController();
      const feed = new PortableWorkspaceFeed(ctx).follow(feedSignal.signal)[Symbol.asyncIterator]();
      assert.equal((await feed.next()).value?.type, 'baseline');
      await portableWorkspaces.pinSession(ids[0]!, true);
      assert.equal(a.updatedAt, beforePin, 'Presentation changes must not rewrite workspace timestamps');
      assert.deepEqual(ctx.executionWorlds.bindings.get(ids[0]!), boundBeforePin);
      assert.ok(portableWorkspaces.worlds()[0]!.pinnedSessionIds.includes(ids[0]!));
      assert.equal((await feed.next()).value?.type, 'order', 'Preference updates notify clients without a fake workspace upsert');
      feedSignal.abort(); await feed.return?.();
      await portableWorkspaces.pinSession(ids[0]!, false);
      await assert.rejects(portableWorkspaces.pinSession(SessionId('unknown-preference'), true));
      console.log('PASS presentation changes notify feed without changing execution binding or workspace timestamps');


      // A rejected selection must fail before any host-directory side effect.
      const localSideEffect = `${base}/unprepared-web-create`;
      await assert.rejects(apiCommands.create({ cwd: localSideEffect }));
      await assert.rejects(stat(localSideEffect), { code: 'ENOENT' });
      console.log('PASS rejected remote creation has no local mkdir side effect');
      const sharedId = SessionId('concurrent-selection');
      const race = await Promise.allSettled([a, b].map(row => apiCommands.create({ workspaceId: row.id, sessionId: sharedId })));
      assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(race.filter(row => row.status === 'rejected').length, 1);
      const selected = ctx.executionWorlds.bindings.get(sharedId)!;
      const winner = [a, b].find(row => portableWorkspaces.definition(row.id).id === selected.id)!;
      const loser = winner.id === a.id ? b : a;
      await apiCommands.create({ workspaceId: winner.id, sessionId: sharedId });
      await assert.rejects(apiCommands.create({ workspaceId: loser.id, sessionId: sharedId }));
      assert.deepEqual(ctx.executionWorlds.bindings.get(sharedId), selected);
      console.log('PASS concurrent same-id requests and later adoption cannot cross Worlds at the same cwd');
      const session = ctx.agents.get(ids[0]!)!.session;
      session.append('turn/start', { turn: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await ctx.sessionPersistence.flush();
      const fork = await apiCommands.fork({ sessionId: ids[0]! });
      assert.deepEqual(ctx.executionWorlds.bindings.get(fork.sessionId), ctx.executionWorlds.bindings.get(ids[0]!));
      assert.ok(a.sessionIds.includes(fork.sessionId));
      await readMarker(fork.sessionId, markerFor(0));
      console.log('PASS native Web fork commits the source World binding before Agent execution');
      const admission = ctx.get('apiSessionAdmission')!;
      const originalPrepare = admission.prepare;
      admission.prepare = async () => { throw new Error('revoked admission'); };
      try {
        const denied = await apiAgents.resolveAgent(ids[0]!);
        assert.ok('error' in denied);
        await assert.rejects(apiCommands.create({ workspaceId: a.id, sessionId: ids[0]! }));
      } finally { admission.prepare = originalPrepare; }
      console.log('PASS failed admission cannot be bypassed by adopting an already-live Agent');
      const saved: Saved = { portableWorkspaceIds: [a.id, b.id], sessionIds: ids,
        runtimeIds: ids.map(id => ctx.executionWorlds.forAgent(ctx.agents.get(id)).remoteWorkspace.client.info.runtime) };
      await writeFile(`${base}/saved.json`, JSON.stringify(saved), { mode: 0o600 });
      await ctx.sessionPersistence.flush();
    } else {
      const saved: Saved = JSON.parse(await readFile(`${base}/saved.json`, 'utf8'));
      const portableWorkspaceId = WorkspaceId(saved.portableWorkspaceIds[0]!);
      const sessionId = SessionId(saved.sessionIds[0]!);
      assert.equal(portableWorkspaces.list().length, 2);
      assert.ok(portableWorkspaces.get(portableWorkspaceId)!.sessionIds.includes(sessionId));
      const savedBindings = saved.sessionIds.map(id => ctx.executionWorlds.bindings.get(id));
      if (phase === 'retired') {
        await assert.rejects(portableWorkspaces.createInWorld(selection.worlds[0]!.id, selection.path), { code: 'WORLD_REQUIRED' });
        assert.equal(connections, 0, 'Retired catalog entries cannot provision new workspaces');
      }
      if (phase === 'changed' || phase === 'unavailable' || phase === 'unbound') {
        if (phase === 'unbound') {
          const file = `${base}/bindings.json`;
          const data = JSON.parse(await readFile(file, 'utf8'));
          data.sessions = data.sessions.filter((row: { sessionId: string }) => row.sessionId !== sessionId);
          await writeFile(file, JSON.stringify(data));
        }
        const result = await apiAgents.resolveAgent(sessionId);
        assert.ok('error' in result);
        await assert.rejects(apiCommands.create({ workspaceId: portableWorkspaceId, sessionId }));
        assert.equal(ctx.agents.get(sessionId), undefined);
        if (!ssh) assert.equal(connections, phase === 'unavailable' ? 2 : 0, 'A failed connection is retried on the next independent admission');
        console.log(`PASS ${phase} World or binding prevents resume and explicit-id redirection`);
      } else {
        if (phase === 'observed-resume') {
          using pinned = await ctx.sessionQuery.observeSession(sessionId);
          const promoted = await apiAgents.resolveObservedAgent(pinned);
          assert.ok('agent' in promoted);
          console.log('PASS cold observed activation prepares the World before publishing its Agent');
        }
        if (phase === 'lookup-resume') {
          const [agent, session, host] = await Promise.all([
            ctx.typert.lookups.get('agent')!.resolve(sessionId),
            ctx.typert.lookups.get('session')!.resolve(sessionId),
            ctx.typert.contexts.getHost('agent')!.resolve(sessionId),
          ]);
          assert.equal(agent, ctx.agents.get(sessionId));
          assert.equal(session, ctx.agents.get(sessionId)!.session);
          assert.equal(host, ctx.agents.get(sessionId)!.ctx);
          console.log('PASS cold Agent/Session/context lookups share prepared activation');
        }
        const [cold, duplicate] = await Promise.all([apiAgents.resolveAgent(sessionId), apiAgents.resolveAgent(sessionId)]);
        assert.ok('agent' in cold); assert.ok('agent' in duplicate);
        assert.equal(cold.agent, duplicate.agent);
        using observation = await ctx.sessionQuery.observeSession(sessionId);
        const observed = await apiAgents.resolveObservedAgent(observation);
        assert.ok('agent' in observed); assert.equal(observed.agent, cold.agent);
        console.log('PASS cold Web resume prepares saved World and deduplicates concurrent activation');
        for (const [index, id] of saved.sessionIds.entries()) {
          const sessionId = SessionId(id), portableWorkspaceId = WorkspaceId(saved.portableWorkspaceIds[index]!);
          const restored = await apiAgents.resolveAgent(sessionId);
          assert.ok('agent' in restored);
          const adopted = await apiCommands.create({ workspaceId: portableWorkspaceId, sessionId });
          assert.equal(adopted.sessionId, id);
          assert.notEqual(ctx.executionWorlds.forAgent(ctx.agents.get(sessionId)).remoteWorkspace.client.info.runtime, saved.runtimeIds[index]);
          await readMarker(sessionId, markerFor(index));
        }
        console.log('PASS native Web resolves saved World and restores JSONL without an external preparation call');
        if (phase === 'retired') {
          assert.deepEqual(saved.sessionIds.map(id => ctx.executionWorlds.bindings.get(id)), savedBindings);
          console.log('PASS retired catalog World refuses new workspaces while existing Sessions restore their exact saved bindings');
        }
      }
    }
  } finally { await ctx.fiber.dispose(); }
}
