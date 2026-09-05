import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionReadOnlyError, SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence';
import WorldSessionPersistence from '../../packages/dsh-ssh/src/persistence.ts';
import type {} from '../../packages/dsh-ssh/src/agents.ts';

async function mount(root: string) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(WorldSessionPersistence, { root });
  return ctx;
}
const title = (seq: number, text: string): SessionEvent => ({ seq: SessionSeq(seq), time: 1, type: 'session/title', data: { title: text, messageSeqs: [], source: { kind: 'user' } } });
if (process.argv[2] === 'lease-child') {
  const ctx = await mount(process.argv[3]!);
  const session = ctx.sessions.prepare(SessionId('crash-owner'));
  const handle = await ctx.sessionPersistence.create(session.header);
  await handle.append([title(0, 'committed before crash')]);
  process.stdout.write('owned\n');
  process.stdin.resume();
  await once(process.stdin, 'end');
  await ctx.fiber.dispose();
} else {
  const root = await mkdtemp('/tmp/dsh-world-storage.');
  const ctx = await mount(root), other = await mount(root);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const session = ctx.sessions.prepare(SessionId('stored'));
    const writer = await ctx.sessionPersistence.create(session.header);
    const reader = await other.sessionPersistence.open(session.id, 'read');
    assert.equal((await ctx.sessionPersistence.stat(session.id))!.eventCount, 0);
    await assert.rejects(other.sessionPersistence.create(session.header), SessionAlreadyExistsError);
    await assert.rejects(other.sessionPersistence.open(session.id, 'write'), SessionAlreadyOwnedError);
    await assert.rejects(reader.append([title(0, 'forbidden')]), SessionReadOnlyError);
    await writer.append([title(0, 'first')]);
    assert.equal((await reader.read()).length, 1);
    const revision = (await other.sessionPersistence.stat(session.id))!.revision;
    await assert.rejects(writer.append([title(2, 'gap')]), /seq mismatch/);
    assert.equal((await reader.read()).length, 1);
    await assert.rejects(writer.append([{ seq: SessionSeq(1), time: 1, type: 'unrecognized/required', data: {} } as unknown as SessionEvent]), SessionFormatUnsupportedError);
    await assert.rejects(writer.append([{ seq: SessionSeq(1), time: 1, type: 'execution-world/bound', data: { schema: 2 } } as unknown as SessionEvent]), SessionFormatUnsupportedError);
    await writer.append([title(1, 'second')]);
    assert.notEqual((await other.sessionPersistence.stat(session.id))!.revision, revision);
    assert.equal((await reader.read()).length, 2);
    await assert.rejects(writer.append([title(2, 'x'.repeat(64 * 1024 * 1024))]), /64 MiB/);
    assert.equal((await reader.read()).length, 2, 'Refused batches leave the acknowledged prefix intact');
    await writer.flush(); await writer.close();
    const reopened = await other.sessionPersistence.open(session.id, 'write');
    assert.equal((await reopened.read()).length, 2);
    await reopened.close(); await reader.close();
    assert.equal((await ctx.sessionPersistence.list()).length, 1);
    console.log('PASS storage: writer exclusion, cross-handle freshness, contiguous atomic batches, unknown/version refusal and bounded growth');

    child = spawn(process.execPath, [import.meta.filename, 'lease-child', root], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exit = once(child, 'exit');
    const [chunk] = await once(child.stdout!, 'data');
    assert.equal(chunk.toString(), 'owned\n');
    await assert.rejects(ctx.sessionPersistence.open(SessionId('crash-owner'), 'write'), SessionAlreadyOwnedError);
    child.kill('SIGKILL'); await exit;
    const recovered = await ctx.sessionPersistence.open(SessionId('crash-owner'), 'write');
    assert.equal(JSON.stringify(await recovered.read()).includes('committed before crash'), true);
    await recovered.append([title(1, 'after crash')]);
    await recovered.close();
    console.log('PASS storage: process death releases SQLite lease and preserves committed events');
  } finally {
    child?.kill('SIGKILL');
    await other.fiber.dispose(); await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
