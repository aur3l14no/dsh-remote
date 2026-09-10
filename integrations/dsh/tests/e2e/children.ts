import { readFile, writeFile } from 'node:fs/promises';
import { expect, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import type { WebScaffold } from './scaffold.ts';

/** Model-only fixture; native continuation, persistence, providers and SSH remain real. */
export async function checkChildLifecycle(launch: () => Promise<WebScaffold>, parentId: SessionId, otherId: SessionId, originalModel: { provider: string; model: string }) {
  let childId: SessionId | undefined;
  for (let epoch = 0; epoch < 2; epoch++) {
    const host = await launch();
    const calls = new Map<string, number>();
    const denied: boolean[] = [];
    host.ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && JSON.stringify(event.data).includes(`continuation-denied-${epoch}`)) {
        denied.push(event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true));
      }
    });
    const adapter = new MockAdapter(Array.from({ length: 12 }, () => (request: GenerateOptions) => {
      if (request.sessionId === parentId) return textResponse('Continuation acknowledged');
      const id = String(request.sessionId);
      const index = calls.get(id) ?? 0;
      calls.set(id, index + 1);
      return [
        toolCallResponse(`continuation-read-${epoch}`, 'read', { file_path: '/workspace/world.txt' }),
        toolCallResponse(`continuation-skill-${epoch}`, 'skill', { name: 'remote-proof' }),
        toolCallResponse(`continuation-exec-${epoch}`, 'bash', { command: `sh "$HOME/.agents/skills/remote-proof/scripts/proof.sh"; printf '${epoch}\\n' >> continuation-proof.txt`, description: 'Run the deployed skill after continuation' }),
        toolCallResponse(`continuation-denied-${epoch}`, 'terminal_open', { type: 'shell' }),
        textResponse('CONTINUATION_CHILD_DONE'),
      ][index] ?? textResponse('Unexpected extra request');
    }));
    host.ctx.llm.registerAdapter(['remote-fixture'], adapter);
    const registry = host.ctx.get('worldPortableWorkspaces');
    const api = host.ctx.get('sessionController');
    await api.create({ sessionId: parentId, workspaceId: registry.forSession(parentId)!.id });
    await api.selectModel({ sessionId: parentId, provider: 'remote-fixture', model: 'fixture' });
    const parent = host.ctx.agents.get(parentId)!;
    const subagents = host.ctx.get('subagents');
    if (childId === undefined) {
      const started = await subagents.startContinuable({ provider: 'spawn', label: 'Durable remote child',
        request: { parent, agentOptions: { provider: 'remote-fixture', model: 'fixture' }, prompt: [{ type: 'text', text: 'Run the skill in the World. Terminal tools are unavailable.' }], toolFilter: { allow: ['read', 'skill', 'bash'] } },
        signal: AbortSignal.timeout(15000) });
      childId = started.childId;
    } else {
      expect(host.ctx.agents.get(childId)).toBeUndefined();
      expect(host.ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog?.filter(entry => entry.id === childId)).toEqual([expect.objectContaining({ id: childId, mode: 'continuable', label: 'Durable remote child' })]);
      expect((await host.ctx.get('sessionSkillCatalog').list({ sessionId: childId }, AbortSignal.timeout(15000))).skills.map(skill => skill.name)).toEqual(['remote-proof', 'world-a']);
      await api.create({ sessionId: otherId, workspaceId: registry.forSession(otherId)!.id });
      await expect(subagents.sendMessage(host.ctx.agents.get(otherId)!, childId, [{ type: 'text', text: 'Wrong parent' }], { signal: AbortSignal.timeout(15000) })).rejects.toThrow();
      await subagents.sendMessage(parent, childId, [{ type: 'text', text: 'Continue in the saved World.' }], { signal: AbortSignal.timeout(15000) });
    }
    await expect.poll(() => calls.get(childId!), { timeout: 20000 }).toBe(5);
    await expect.poll(() => host.ctx.agents.get(childId!), { timeout: 15000 }).toBeUndefined();
    await expect.poll(() => adapter.requests.some(request => request.sessionId === parentId), { timeout: 15000 }).toBe(true);
    await parent.whenIdle();
    expect(host.ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog?.filter(entry => entry.id === childId)).toEqual([expect.objectContaining({ id: childId, mode: 'continuable', label: 'Durable remote child' })]);
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog' && event.data.childId === childId)).toHaveLength(1);
    const childRequests = adapter.requests.filter(request => request.sessionId === childId);
    expect(JSON.stringify(childRequests)).toContain('WORLD_INSTRUCTIONS_A');
    expect(JSON.stringify(childRequests)).toContain('remote-proof');
    expect(JSON.stringify(childRequests)).not.toContain('WORLD_INSTRUCTIONS_B');
    expect(registry.forSession(childId)).toBeUndefined();
    expect((await registry.contextForSession(childId)).id).toBe(registry.forSession(parentId)!.id);
    const owner = host.ctx.get('executionWorlds').forAgent(parent);
    expect(await owner.fs.readText(await owner.fs.resolve('continuation-proof.txt'))).toBe(epoch === 0 ? '0\n' : '0\n1\n');
    expect(denied).toEqual([true]);
    expect(childRequests.flatMap(request => request.tools ?? []).map(tool => tool.name)).not.toContain('terminal_open');
    if (epoch === 0) await checkCatalogAppendFailure(host, parent);
    if (epoch === 1) {
      const file = `${process.env.DSH_REMOTE_STATE}/bindings.json`;
      const original = await readFile(file, 'utf8');
      const altered = JSON.parse(original);
      const childBinding = altered.sessions.find((row: { sessionId: string }) => row.sessionId === childId);
      childBinding.worldId = altered.sessions.find((row: { sessionId: string }) => row.sessionId === otherId).worldId;
      try {
        await writeFile(file, JSON.stringify(altered), { mode: 0o600 });
        await expect(registry.contextForSession(childId)).rejects.toThrow('crosses portable workspaces');
        await expect(subagents.sendMessage(parent, childId, [{ type: 'text', text: 'Must reject changed binding' }], { signal: AbortSignal.timeout(15000) })).rejects.toThrow();
        expect(calls.get(childId)).toBe(5);
        expect(host.ctx.agents.get(childId)).toBeUndefined();
      } finally { await writeFile(file, original, { mode: 0o600 }); }
    }
    await api.selectModel({ sessionId: parentId, ...originalModel });
    await host.close();
  }
}

/** Fail the parent's durable publication after real SSH child admission, then prove recovery. */
async function checkCatalogAppendFailure(host: WebScaffold, parent: Agent) {
  const subagents = host.ctx.get('subagents');
  const worlds = host.ctx.get('executionWorlds');
  const catalog = () => host.ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog ?? [];
  const adapter = new MockAdapter(Array.from({ length: 12 }, () => textResponse('CATALOG_RECOVERY_DONE')));
  host.ctx.llm.registerAdapter(['catalog-fixture'], adapter);
  await host.ctx.get('sessionController').selectModel({ sessionId: parent.id, provider: 'catalog-fixture', model: 'fixture' });
  const request = { parent, agentOptions: { provider: 'catalog-fixture', model: 'fixture' },
    prompt: [{ type: 'text' as const, text: 'Reply with the completion marker.' }], toolFilter: { allow: [] } };
  for (const mode of ['one-shot', 'continuable'] as const) {
    const before = catalog();
    const failure = new Error(`Injected ${mode} catalog append failure`);
    let rejectedChild: SessionId | undefined;
    const append = parent.session.append.bind(parent.session);
    const spy = vi.spyOn(parent.session, 'append').mockImplementation(((...args: Parameters<typeof append>) => {
      if (args[0] === 'subagent/catalog') {
        rejectedChild = (args[1] as { childId: SessionId }).childId;
        throw failure;
      }
      return Reflect.apply(append, parent.session, args);
    }) as typeof parent.session.append);
    try {
      const signal = AbortSignal.timeout(15000);
      await expect(mode === 'one-shot'
        ? subagents.start('spawn', { ...request, signal })
        : subagents.startContinuable({ provider: 'spawn', label: 'Rejected catalog child', request, signal }))
        .rejects.toBe(failure);
    } finally { spy.mockRestore(); }
    expect(rejectedChild).toBeDefined();
    await expect.poll(() => host.ctx.agents.get(rejectedChild!), { timeout: 15000 }).toBeUndefined();
    expect(catalog()).toEqual(before);
    expect(parent.session.snapshotEvents().some(event => event.type === 'subagent/catalog' && event.data.childId === rejectedChild)).toBe(false);
    expect(worlds.bindings.get(rejectedChild!)).toEqual(worlds.bindings.get(parent.id));

    let recoveredChild: SessionId;
    if (mode === 'one-shot') {
      const run = await subagents.start('spawn', { ...request, signal: AbortSignal.timeout(15000) });
      recoveredChild = run.id;
      try { expect((await run.result).output).toEqual([{ type: 'text', text: 'CATALOG_RECOVERY_DONE' }]); }
      finally { await run.dispose(); }
    } else {
      recoveredChild = (await subagents.startContinuable({ provider: 'spawn', label: 'Recovered catalog child', request, signal: AbortSignal.timeout(15000) })).childId;
      await expect.poll(() => adapter.requests.some(call => call.sessionId === recoveredChild), { timeout: 15000 }).toBe(true);
    }
    await expect.poll(() => host.ctx.agents.get(recoveredChild), { timeout: 15000 }).toBeUndefined();
    await parent.whenIdle();
    expect(catalog().filter(entry => entry.id === recoveredChild)).toEqual([expect.objectContaining({ id: recoveredChild, mode })]);
    expect(worlds.bindings.get(recoveredChild)).toEqual(worlds.bindings.get(parent.id));
  }
}
