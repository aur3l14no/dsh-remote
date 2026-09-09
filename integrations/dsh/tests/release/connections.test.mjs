import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sshControl } from '../../../../runtime/ssh/src/control.ts';
import { createConnections } from '../../packaging/extension/connections.mjs';

test('Connect requires noninteractive public-key login and trusted host keys, preserving existing configuration', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-connect-test-'));
  const oldPath = process.env.PATH;
  let connections;
  try {
    await mkdir(join(state, 'bin'));
    await writeFile(join(state, 'bin/ssh'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(state, 'args'))}, JSON.stringify(process.argv));
if(process.argv.includes('bad-host')) process.exit(255);
process.stdout.write('/home/dev\\n');\n`, { mode: 0o700 });
    process.env.PATH = join(state, 'bin') + ':' + oldPath;
    let config = { worlds: [], bindingFile: '/preserved/bindings' };
    connections = createConnections(() => structuredClone(config), value => { config = value; }, sshControl);
    const [a, b] = await Promise.all([connections.connect('dev@example.test'), connections.connect('dev@example.test')]);
    assert.deepEqual(a, b); assert.equal(a.home, '/home/dev');
    assert.equal(config.worlds.length, 1); assert.equal(config.bindingFile, '/preserved/bindings');
    const args = JSON.parse(await readFile(join(state, 'args'), 'utf8'));
    for (const option of ['PreferredAuthentications=publickey', 'BatchMode=yes', 'StrictHostKeyChecking=yes']) assert.ok(args.includes(option));
    assert.throws(() => connections.connect('-oProxyCommand=bad'));
    await assert.rejects(connections.connect('bad-host'), /First run ssh bad-host/);
    assert.equal(config.worlds.length, 1);
  } finally {
    await connections?.dispose(); process.env.PATH = oldPath;
    await rm(state, { recursive: true, force: true });
  }
});
