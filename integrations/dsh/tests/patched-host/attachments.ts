import * as NativeWorkspaces from '../../packages/workspace/local-workspace/src/native.ts';
/** Real Session/World storage and native model conversion; runs with native or Linux/SSH providers. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-presets';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
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
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { ApiSessionAgentController } from '@dsh-test/web-agent';
import { SessionCommandController } from '@dsh-test/web-commands';
import { installModelSelectionProjection } from '@dsh-test/web-model-selection-projection';
import { BindingStore } from '../../packages/world/ssh-world/src/bindings.ts';
import ExecutionWorlds, { executionWorldsPlugin } from '../../packages/world/ssh-world/src/worlds.ts';
import * as Routing from '../../packages/world/ssh-world/src/routing.ts';
import PortableWorkspaces from '../../packages/workspace/portable-workspace/src/registry.ts';
import * as Admission from '../../packages/workspace/portable-workspace/src/admission.ts';
import RemoteAttachments from '../../packages/workspace/remote-attachments/src/index.ts';
import { runtime } from '../../../../runtime/tests/client/support.ts';
import { readFile as readRemote, writeFile as writeRemote } from '../../../../runtime/client/src/index.ts';

const base = await realpath(await mkdtemp('/tmp/dsh-attachments.'));
const ssh = Boolean(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG);
await mkdir(`${base}/workspace`);
const selection = ssh ? JSON.parse(await readFile(process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG!, 'utf8')) : {
  worlds: ['a', 'b'].map(id => ({ id, name: id, target: { kind: 'ssh', host: 'native-attachment.invalid' } })), path: `${base}/workspace`,
};
BindingStore.create(`${base}/bindings.json`);
const png = await sharp({ create: { width: 13, height: 7, channels: 3, background: '#286a49' } }).png().toBuffer();
const body = Buffer.concat([Buffer.from('REMOTE_FILE\n'), Buffer.alloc(160000, 97)]);
const wireRequests: unknown[] = [];
const server = createServer((request, response) => {
  let text = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { text += chunk; });
  request.on('end', () => {
    wireRequests.push(JSON.parse(text));
    // Serialization is the subject here; a deterministic provider refusal avoids inventing a model result.
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'synthetic request captured', type: 'invalid_request_error' } }));
  });
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
process.env.DSH_ATTACHMENT_TEST_KEY = 'synthetic-attachment-key';
let ctx: Context | undefined;
async function start() {
  const current = new Context();
  ctx = current;
  current.baseUrl = pathToFileURL(`${base}/`).href;
  await current.plugin(Loader);
  current.loader.builtins = { include: Include, group: Group, fs: Routing.RoutedFileSystem, subprocess: Routing.RoutedSubprocess, routing: Routing, files: FileTools };
  for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, AgentRegistry, SessionProjectionRegistry, Storage, TypertRegistry]) await current.plugin(plugin);
  await current.plugin(JsonlPersistence, { root: `${base}/sessions`, compression: 'none' });
  await current.plugin(SessionQuery, { path: ':memory:', openAt: 'never' });
  await current.plugin(JsonStorage, { root: `${base}/workspaces` });
  await current.plugin(StorageDomain, { backend: 'json' });
  await current.plugin(ToolRuntime, { mode: 'native' });
  await current.plugin(AgentDefaultModel, { provider: 'openai', model: 'gpt-4.1' });
  installModelSelectionProjection(current);
  const provider = ssh ? ExecutionWorlds : executionWorldsPlugin(async definition => {
    const native = await runtime({ world: definition.id, cwd: definition.cwd, lease: 5000 });
    return { client: native.client, ripgrep: resolve(process.env.DSH_TEST_RG!), dataRoot: `${base}/remote-${definition.id}`, close: () => native.close() };
  });
  await current.plugin(provider, { bindingFile: `${base}/bindings.json`, packagedRipgrep: await SearchTools.resolveRgPath(), bootstrap: {
    manifest: ssh ? JSON.parse(await readFile(process.env.DSH_TEST_BOOTSTRAP_MANIFEST!, 'utf8')) : {},
    cacheDir: ssh ? process.env.DSH_TEST_ARTIFACT_CACHE! : base, graceMs: 15000, leaseMs: 5000,
  } });
  await current.plugin(AgentLoop, { agents: [] });
  await mkdir(`${base}/remote`, { recursive: true });
  await writeFile(`${base}/remote/agent.cordis.yml`, JSON.stringify([{ name: 'cordis:group', isolate: { fs: true, subprocess: true, toolBashWorkdir: true }, config: [
    { name: 'cordis:fs' }, { name: 'cordis:subprocess' }, { name: 'cordis:routing', config: { providerPaths: true } }, { name: 'cordis:files' },
  ] }]));
  await current.plugin(AgentPresets, { default: 'remote', roots: [{ path: base, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
  await current.plugin(NativeWorkspaces);
  await current.plugin(PortableWorkspaces, { worlds: selection.worlds });
  await current.plugin(Admission);
  await current.plugin(RemoteAttachments, { dshHome: `${base}/home` });
  await current.plugin(LlmPiAi, { providers: { openai: { apiKeyEnv: 'DSH_ATTACHMENT_TEST_KEY', baseURL: endpoint } } });
  const agents = new ApiSessionAgentController(current);
  return { ctx: current, agents, commands: new SessionCommandController(current, agents, base) };
}
try {
  let host = await start();
  const workspaces = await Promise.all(selection.worlds.map((world: { id: string }) => host.ctx.worldPortableWorkspaces.createInWorld(world.id, selection.path)));
  const ids = await Promise.all(workspaces.map(async (workspace: { id: never }) => (await host.commands.create({ workspaceId: workspace.id })).sessionId));
  const stores = ids.map(id => host.ctx.attachments.forSession(id));
  await assert.rejects(host.ctx.attachments.saveImage({ data: png, mediaType: 'image/png' }), { code: 'WORLD_REQUIRED' });
  const images = await Promise.all(stores.map(store => store.saveImage({ data: png, mediaType: 'image/png', name: 'uploaded.png' })));
  assert.notEqual(images[0]!.attachmentId, images[1]!.attachmentId, 'same bytes retain separate World ownership');
  await assert.rejects(stores[1]!.readImage(images[0]!), { code: 'INVALID_ATTACHMENT_REF' });
  const again = await stores[0]!.saveImage({ data: png, mediaType: 'image/png', name: 'again.png' });
  assert.equal(again.attachmentId, images[0]!.attachmentId);
  const file = await stores[0]!.saveFileStream({ name: '../payload.bin', data: (async function* () { yield body.subarray(0, 70); yield body.subarray(70); })() });
  const path = stores[0]!.fileExecutionPath(file)!;
  const imagePath = stores[0]!.imageExecutionPath(images[0]!)!;
  const owner = host.ctx.executionWorlds.forSession(ids[0]!);
  assert.deepEqual((await readRemote(owner.remoteWorld.client, path, body.length)).data, body);
  assert.deepEqual(Buffer.concat(await Array.fromAsync(stores[0]!.readFileStream(file))), body);
  await assert.rejects(readFile(`${base}/home/attachments/v1/objects/${images[0]!.attachmentId.slice(7, 9)}/${images[0]!.attachmentId.slice(7, 71)}`), { code: 'ENOENT' });
  assert.deepEqual(await readdir(`${base}/home/remote/attachment-staging`), []);
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: images[0]! }, { type: 'file', attachment: file }] });
  const agent = host.ctx.agents.get(ids[0]!)!;
  agent.session.append('turn/start', { turn: 1 });
  agent.session.append('user/message', message, { surfaceOp: 'append' });
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await host.ctx.sessionPersistence.flush();
  const response = await host.commands.attachment({ sessionId: ids[0]!, attachmentId: images[0]!.attachmentId });
  assert.deepEqual(Buffer.from(response.data, 'base64'), (await stores[0]!.readImage(images[0]!)).data);
  const chunks = await Array.fromAsync(host.ctx.llm.stream({ provider: 'openai', model: 'gpt-4.1', sessionId: ids[0]!, messages: [message], signal: AbortSignal.timeout(15000) }));
  assert.ok(chunks.some(chunk => chunk.type === 'finish'), 'native adapter completed after controlled provider refusal');
  assert.equal(wireRequests.length, 1);
  const wire = JSON.stringify(wireRequests[0]);
  assert.ok(wire.includes('data:image/'), 'native provider request contains image bytes');
  assert.ok(wire.includes(path), 'native LLM file projection supplies the remote tool path');
  assert.ok(wire.includes(imagePath), 'native image projection supplies the remote tool path');
  assert.ok(!wire.includes(`${base}/home`), 'no host attachment cache path reaches the model');
  console.log('PASS remote authority, bounded file streaming, namespace isolation, native model image conversion and file paths');

  const readImageTool = await host.ctx.tools.execute({ agent, name: 'read_image', arguments: { file_path: imagePath }, callId: ToolCallId('attachment-read-image'), signal: AbortSignal.timeout(15000) });
  assert.equal(readImageTool.isError, false, JSON.stringify(readImageTool));
  assert.ok(JSON.stringify(readImageTool).includes(images[0]!.attachmentId), 'tool image retains World namespace');
  const abort = new AbortController();
  const before = await readdir(`${base}/home/remote/attachment-staging`);
  await assert.rejects(stores[0]!.saveFileStream({ name: 'cancelled', signal: abort.signal, data: (async function* () { yield Buffer.from('prefix'); abort.abort(new Error('synthetic cancellation')); yield Buffer.from('tail'); })() }), /synthetic cancellation/);
  assert.deepEqual(await readdir(`${base}/home/remote/attachment-staging`), before);
  const invalidBatch = [{ data: png, mediaType: 'image/png' as const }, { data: Buffer.from('invalid'), mediaType: 'image/png' as const }];
  await assert.rejects(stores[0]!.saveImages(invalidBatch));
  const fork = await host.commands.fork({ sessionId: ids[0]! });
  await host.ctx.sessionPersistence.flush();
  await host.ctx.fiber.dispose();
  host = await start();
  // No live Agent or tool ALS exists for the historical preview.
  assert.equal(host.ctx.agents.get(ids[0]!), undefined);
  const cold = await host.commands.attachment({ sessionId: ids[0]!, attachmentId: images[0]!.attachmentId });
  assert.equal(cold.attachment.attachmentId, images[0]!.attachmentId);
  const forked = await host.commands.attachment({ sessionId: fork.sessionId, attachmentId: images[0]!.attachmentId });
  assert.equal(forked.data, cold.data);
  const resumed = host.ctx.attachments.forSession(ids[0]!);
  assert.equal(resumed.fileExecutionPath(file), path);
  console.log('PASS remote attachments survive runtime shutdown, host restart, cold preview and native Session fork');

  const legacyCtx = new Context();
  const legacy = new LocalAttachmentStore(legacyCtx, { dshHome: `${base}/home` });
  const legacyRef = await legacy.saveImage({ data: png, mediaType: 'image/png' });
  assert.ok(!legacyRef.attachmentId.includes('@world-'));
  assert.ok((await resumed.readImage(legacyRef)).data.length > 0, 'legacy refs explicitly retain their original host store');
  const corruptOwner = host.ctx.executionWorlds.forSession(ids[0]!);
  const original = (await resumed.readImage(images[0]!)).data;
  await writeRemote(corruptOwner.remoteWorld.client, imagePath, new Uint8Array(original.length));
  await assert.rejects(resumed.readImage(images[0]!), { code: 'ATTACHMENT_CORRUPT' });
  await assert.rejects(resumed.readImageRequest(images[0]!, { maxPixels: 1024, maxBytes: 1024 }), { code: 'ATTACHMENT_CORRUPT' });
  // A local object with the same content digest must never rescue a remote read.
  await writeRemote(corruptOwner.remoteWorld.client, imagePath, original);
  await corruptOwner.subprocess.spawn({ argv: ['rm', '--', imagePath], cwd: selection.path, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 }).done;
  await assert.rejects(resumed.readImage(images[0]!), { code: 'ATTACHMENT_NOT_FOUND' });
  await assert.rejects(resumed.readImageRequest(images[0]!, { maxPixels: 1024, maxBytes: 1024 }), { code: 'ATTACHMENT_NOT_FOUND' });
  await assert.rejects(resumed.readImage({ ...images[0]!, attachmentId: legacyRef.attachmentId + '@world-' + '0'.repeat(64) } as ImageAttachmentRef), { code: 'INVALID_ATTACHMENT_REF' });
  await legacyCtx.fiber.dispose();
  console.log('PASS legacy compatibility, cancellation cleanup and no host fallback for missing/corrupt remote images');
} finally {
  await ctx?.fiber.dispose();
  await new Promise<void>(accept => server.close(() => accept()));
  await rm(base, { recursive: true, force: true });
}
