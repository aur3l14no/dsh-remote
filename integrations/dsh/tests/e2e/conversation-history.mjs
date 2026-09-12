import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install', 'package.json'));
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
class HistoryAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream() {
    const text = 'Workspace history fixture response.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const provider = 'history-fixture';
const registered = new WeakSet();
function installAdapter(ctx) {
  if (registered.has(ctx)) return;
  ctx.get('llm').registerAdapter([provider], new HistoryAdapter());
  registered.add(ctx);
}

/** A real conversation turn through a deterministic adapter; no external model. */
export async function recordConversation(ctx, agent) {
  const deadline = Date.now() + 10000;
  while (!ctx.get('worldPortableWorkspaces').forSession(agent.id)) {
    if (Date.now() >= deadline) throw new Error('History fixture session was not admitted');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const previous = { provider: agent.options.provider, model: agent.options.model };
  installAdapter(ctx);
  const controller = ctx.get('sessionController');
  await controller.selectModel({ sessionId: agent.id, provider, model: 'fixture' });
  await controller.prompt({ sessionId: agent.id, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Record a workspace conversation for the history fixture.' }],
  }, AbortSignal.timeout(10000));
  await agent.whenIdle();
  if (previous.provider && previous.model) await controller.selectModel({ sessionId: agent.id, ...previous });
}

// Only mounted by isolated CLI history tests; never packaged with the extension.
export function apply(ctx, config = {}) {
  installAdapter(ctx);
  ctx.on('agent/created', ({ agent }) => {
    for (let seq = 0; seq < agent.session.seq; seq++) {
      if (agent.session.eventAt(seq)?.type === 'turn/start') return;
    }
    setImmediate(() => {
      void recordConversation(ctx, agent).then(async () => {
        if (config.restoreModel) await ctx.get('sessionController').selectModel({ sessionId: agent.id, ...config.restoreModel });
      }).catch(error => { throw error; });
    });
  });
}
