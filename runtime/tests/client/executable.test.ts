import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RemoteProcess } from '../../client/src/index.ts';
import { runtime, fixture } from './support.ts';

test('real helper: PATH and absolute symlink executables preserve the invoked multicall name', { timeout: 20000 }, async () => {
  const r = await runtime();
  try {
    const bin = join(r.dir, 'bin');
    const linkedBin = join(r.dir, 'linked-bin');
    const alias = join(bin, 'fixture-applet');
    await mkdir(bin);
    await symlink(bin, linkedBin);
    await symlink(fixture, alias);
    const env = { PATH: linkedBin };
    for (const command of ['fixture-applet', join(linkedBin, 'fixture-applet')]) {
      const resolved = await r.client.request<{ path: string }>('process.resolveExecutable', { command, cwd: r.dir, env });
      assert.equal(resolved.path, alias, 'resolution retains the final symlink name');
      for (const executable of [command, resolved.path]) {
        const process = await RemoteProcess.spawn(r.client, {
          argv: [executable, 'invocation'], cwd: r.dir, env,
          stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 },
        });
        assert.equal((await process.done).rootExit?.code, 0);
        assert.equal(process.collected[0]!.readBytes().data.toString().trim(), alias);
        await process.release();
      }
    }
  } finally { await r.close(); }
});
