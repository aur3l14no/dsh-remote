import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { glob, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { WebScaffold } from './scaffold.ts';

/** Install a synthetic released-V2 history in a closed, disposable test Session. */
export async function seedLegacySession(state: string, id: SessionId, config: { provider: string; model: string }) {
  for await (const relative of glob('**/session.v3.jsonl*', { cwd: join(state, 'sessions') })) {
    const current = join(state, 'sessions', relative);
    const decode = (bytes: Buffer) => (current.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes).toString('utf8');
    const header = JSON.parse(decode(await readFile(current)).split('\n')[0]!);
    if (header.id !== id) continue;
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', surfaceOp: 'append', data: { id: 'legacy-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LEGACY_REMOTE_HISTORY' }] } },
      { type: 'request/header', data: { header: { config, system: 'LEGACY_REMOTE_SYSTEM' }, reason: 'change' } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const original = [{ ...header, version: 2 }, ...rows.map((row, seq) => ({ ...row, seq, time: header.createdAt + seq + 1 }))].map(row => JSON.stringify(row)).join('\n') + '\n';
    const legacy = current.replace('session.v3.jsonl', 'session.v2.jsonl');
    const originalBytes = current.endsWith('.zstd') ? Buffer.concat(original.trimEnd().split('\n').map(line => zstdCompressSync(Buffer.from(line + '\n')))) : Buffer.from(original);
    await writeFile(legacy, originalBytes, { flag: 'wx' });
    await rm(current);
    const bindings = await readFile(join(state, 'bindings.json'), 'utf8');
    return async (host: WebScaffold) => {
      const workspace = host.ctx.get('worldPortableWorkspaces').forSession(id)!;
      expect(workspace).toBeDefined();
      await host.ctx.get('sessionController').create({ sessionId: id, workspaceId: workspace.id });
      const agent = host.ctx.agents.get(id)!;
      expect(agent.session.header.version).toBe(3);
      const history = JSON.stringify(agent.session.surface.nodes.map(seq => agent.session.eventAt(seq)));
      expect(history).toContain('LEGACY_REMOTE_HISTORY');
      expect(history).toContain('LEGACY_REMOTE_SYSTEM');
      const owner = host.ctx.get('executionWorlds').forAgent(agent);
      expect(await owner.fs.readText(await owner.fs.resolve('world.txt'))).toBe('b\n');
      await host.ctx.sessionPersistence.flush();
      expect(await readFile(legacy)).toEqual(originalBytes);
      expect(JSON.parse(decode(await readFile(current)).split('\n')[0]!)).toMatchObject({ id, version: 3, cwd: '/workspace' });
      expect(await readFile(join(state, 'bindings.json'), 'utf8')).toBe(bindings);
    };
  }
  throw new Error(`No persisted test Session ${id}`);
}
