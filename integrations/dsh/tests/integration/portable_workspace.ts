/** Real PortableWorkspace service replacement + native Web activation witnesses; no browser/UI claim. */
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
import { BindingStore } from '../../packages/world/ssh-world/src/bindings.ts';
import ExecutionWorlds, { executionWorldsPlugin } from '../../packages/world/ssh-world/src/worlds.ts';
import * as Routing from '../../packages/world/ssh-world/src/routing.ts';
import PortableWorkspaces, { type CatalogWorld } from '../../experiments/portable_workspace/registry.ts';
import { startPortableWorkspaceSession, openPortableWorkspaceSession } from '../../experiments/portable_workspace/entry.ts';
import { runtime } from '../../../../runtime/tests/client/support.ts';

const phase = process.argv[2];
const ssh = !!process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG;
interface Selection { worlds: CatalogWorld[]; path: string }
interface Saved { portableWorkspaceIds: string[]; sessionIds: string[]; runtimeIds: string[] }
if (!phase) {
  const base = await mkdtemp('/tmp/dsh-portable_workspace-experiment.');
  try {
    let selection: Selection;
    if (ssh) selection = JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG!, 'utf8'));
    else {
      await mkdir(`${base}/workspace`);
      selection = { worlds: ['a', 'b'].map(id => ({ id, name: `World ${id}`, target: { kind: 'ssh', host: 'native-acceptance.invalid' } })),
        path: await realpath(`${base}/workspace`) };
    }
    assert.equal(selection.worlds.length, 2, 'Acceptance requires two configured Worlds');
    await writeFile(`${base}/selection.json`, JSON.stringify(selection), { mode: 0o600 });
    BindingStore.create(`${base}/bindings.json`);
    for (const phase of ['create', 'resume', 'missing', 'changed']) {
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
  const rg = resolve(process.env.DSH_TEST_RG!);
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
      const r = await runtime({ world: definition.id, cwd: definition.cwd, lease: 5000 });
      return { client: r.client, ripgrep: rg, close: () => r.close() };
    });
    await ctx.plugin(provider, { bindingFile: `${base}/bindings.json`, packagedRipgrep: await SearchTools.resolveRgPath(),
      bootstrap: { manifest: ssh ? JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')) : {},
        cacheDir: process.env.DSH_TEST_ARTIFACT_CACHE ?? base, graceMs: 15000, leaseMs: 5000 } });
    await ctx.plugin(AgentLoop, { agents: [] });
    await mkdir(`${base}/shared`, { recursive: true });
    await writeFile(`${base}/shared/agent.cordis.yml`, JSON.stringify([
      { id: 'world-routing', name: 'cordis:group', isolate: { fs: true, subprocess: true }, config: [
        { name: 'cordis:fs' }, { name: 'cordis:subprocess' }, { name: 'cordis:routing' }, { name: 'cordis:files' },
      ] },
    ]));
    await ctx.plugin(AgentPresets, { default: 'shared', roots: [{ path: base, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
    const configured = structuredClone(selection.worlds);
    if (phase === 'missing') configured.splice(0, 1);
    if (phase === 'changed') configured[0]!.target = { ...configured[0]!.target, host: 'changed-acceptance.invalid' };
    await ctx.plugin(PortableWorkspaces, { worlds: configured });
    assert.ok(ctx.workspaceRegistry instanceof PortableWorkspaces, 'The local Workspace registry must be replaced');
    const portableWorkspaces = ctx.worldPortableWorkspaces;
    // These are the unchanged controllers used inside DSH's Web Session facade.
    const apiAgents = new ApiSessionAgentController(ctx);
    const apiCommands = new SessionCommandController(ctx, apiAgents, base);
    const readMarker = async (sessionId: SessionId, marker: string) => {
      const result = await ctx.tools.execute({ agent: ctx.agents.get(sessionId), name: 'read',
        arguments: { file_path: 'portable_workspace-marker.txt' }, callId: ToolCallId(`portable_workspace-${sessionId}`), signal: AbortSignal.timeout(10000) });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(JSON.stringify(result).includes(marker));
    };
    if (phase === 'create') {
      const a = await portableWorkspaces.createInWorld(selection.worlds[0]!.id, selection.path);
      const b = await portableWorkspaces.createInWorld(selection.worlds[1]!.id, selection.path);
      assert.equal(a.path, b.path); assert.notEqual(a.id, b.id);
      assert.equal((await portableWorkspaces.createInWorld(selection.worlds[0]!.id, `${selection.path}/.`)).id, a.id);
      await assert.rejects(portableWorkspaces.create(selection.path), { code: 'WORLD_REQUIRED' });
      await assert.rejects(portableWorkspaces.resolveByPath(selection.path), { code: 'WORLD_REQUIRED' });
      assert.equal(portableWorkspaces.list().length, 2);
      console.log('PASS two catalog Worlds with the same canonical workspace remain distinct PortableWorkspaces');
      const ids = await Promise.all([a, b].map(portableWorkspace => startPortableWorkspaceSession(ctx, portableWorkspace.id)));
      for (const [index, portableWorkspace] of [a, b].entries()) {
        const id = ids[index]!;
        const adopted = await apiCommands.create({ workspaceId: portableWorkspace.id, sessionId: id });
        assert.equal(adopted.sessionId, id);
        const resolved = await apiAgents.resolveAgent(id);
        assert.ok('agent' in resolved); assert.equal(resolved.agent.id, id);
        assert.deepEqual(portableWorkspace.sessionIds, [id]);
        const owner = ctx.executionWorlds.forAgent(ctx.agents.get(id));
        const marker = ssh ? `world-${index}` : 'native-shared-directory';
        await owner.fs.writeText(await owner.fs.resolve('portable_workspace-marker.txt'), marker);
      }
      for (const [index, id] of ids.entries()) await readMarker(id, ssh ? `world-${index}` : 'native-shared-directory');
      assert.equal(serviceForAgent(ctx, ctx.agents.get(ids[0]!)!, 'fs'), serviceForAgent(ctx, ctx.agents.get(ids[1]!)!, 'fs'));
      await assert.rejects(b.attachSession(ids[0]!), { code: 'WORLD_MISMATCH' });
      console.log('PASS PortableWorkspace entry creates native bound Agents; unchanged Web activation adopts them under one shared preset');

      // Deliberately confined to the test-owned directory: witness the unprepared Web route's local mkdir.
      const localSideEffect = `${base}/unprepared-web-create`;
      await assert.rejects(apiCommands.create({ cwd: localSideEffect }));
      assert.ok((await stat(localSideEffect)).isDirectory());
      console.log('GAP native Web create makes a local directory before preset/binding admission');
      const saved: Saved = { portableWorkspaceIds: [a.id, b.id], sessionIds: ids,
        runtimeIds: ids.map(id => ctx.executionWorlds.forAgent(ctx.agents.get(id)).remoteWorld.client.info.runtime) };
      await writeFile(`${base}/saved.json`, JSON.stringify(saved), { mode: 0o600 });
      await ctx.sessionPersistence.flush();
    } else {
      const saved: Saved = JSON.parse(await readFile(`${base}/saved.json`, 'utf8'));
      const portableWorkspaceId = WorkspaceId(saved.portableWorkspaceIds[0]!);
      const sessionId = SessionId(saved.sessionIds[0]!);
      assert.equal(portableWorkspaces.list().length, 2);
      assert.ok(portableWorkspaces.get(portableWorkspaceId)!.sessionIds.includes(sessionId));
      if (phase === 'missing' || phase === 'changed') {
        const code = phase === 'missing' ? 'WORLD_REQUIRED' : 'WORLD_MISMATCH';
        await assert.rejects(openPortableWorkspaceSession(ctx, portableWorkspaceId, sessionId), { code });
        assert.equal(ctx.agents.get(sessionId), undefined);
        assert.equal(connections, 0);
        console.log(`PASS ${phase} catalog configuration cannot resume or redirect a saved PortableWorkspace`);
      } else {
        const cold = await apiAgents.resolveAgent(sessionId);
        assert.ok('error' in cold, 'Cold Web resume must not publish an unprepared Agent');
        assert.match(cold.error.message, /Prepare the saved World/);
        assert.equal(ctx.agents.get(sessionId), undefined);
        assert.equal(connections, 0);
        assert.throws(() => ctx.typert.lookups.configure('agent', async () => { throw new Error('unused'); }), /already configured/);
        console.log('GAP cold Web activation has no async World preparation; the owned Agent lookup rejects a second resolver');
        for (const [index, id] of saved.sessionIds.entries()) {
          const sessionId = SessionId(id), portableWorkspaceId = WorkspaceId(saved.portableWorkspaceIds[index]!);
          await openPortableWorkspaceSession(ctx, portableWorkspaceId, sessionId);
          const adopted = await apiCommands.create({ workspaceId: portableWorkspaceId, sessionId });
          assert.equal(adopted.sessionId, id);
          assert.notEqual(ctx.executionWorlds.forAgent(ctx.agents.get(sessionId)).remoteWorld.client.info.runtime, saved.runtimeIds[index]);
          await readMarker(sessionId, ssh ? `world-${index}` : 'native-shared-directory');
        }
        console.log('PASS PortableWorkspace entry prepares the saved World and native JSONL resume is adopted by unchanged Web activation');
      }
    }
  } finally { await ctx.fiber.dispose(); }
}
