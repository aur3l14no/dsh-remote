/** Dispatch proof complements the installed native macOS execution acceptance. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import ExecutionWorlds, { executionWorldsPlugin } from '../../packages/world/execution-world/src/worlds.ts';
import { BindingStore } from '../../packages/world/execution-world/src/bindings.ts';

const directory = await mkdtemp('/tmp/dsh-local-dispatch-');
const native = new Context();
const owner = new Context();
let remotePreparation = 0, remoteConnect = 0, remoteSkills = 0;
// Identity-only sentinels: actual native filesystem/process behavior is covered by local-e2e.
const fs = Object.freeze({}) as Context['fs'];
const subprocess = Object.freeze({}) as Context['subprocess'];
native.provide('fs', fs); native.provide('subprocess', subprocess);
try {
  const bindingFile = `${directory}/bindings.json`;
  BindingStore.create(bindingFile);
  const config = { local: native, bindingFile, packagedRipgrep: '/unused',
    bootstrap: async () => { remotePreparation++; throw new Error('Local must not load a runtime manifest'); },
    beforeConnect: async () => { remoteSkills++; throw new Error('Local must not deploy remote skills'); },
  };
  await owner.plugin(executionWorldsPlugin(async () => { remoteConnect++; throw new Error('Local must not connect SSH'); }), config);
  const worlds = owner.executionWorlds;
  const local = { id: 'local-project', worldId: 'local', kind: 'local' as const, cwd: directory };
  await worlds.bind('local-session', local);
  const prepared = await worlds.prepareWorld(local);
  assert.equal(prepared.fs, fs); assert.equal(prepared.subprocess, subprocess);
  assert.equal(prepared.get('remoteWorld'), undefined);
  assert.deepEqual([remotePreparation, remoteConnect, remoteSkills], [0, 0, 0]);
  // Also exercise the production adapter with no injected SSH connector.
  const production = new Context();
  try {
    await production.plugin(ExecutionWorlds, config);
    await production.executionWorlds.prepare('local-session');
    assert.deepEqual([remotePreparation, remoteConnect, remoteSkills], [0, 0, 0]);
  } finally { await production.fiber.dispose(); }
  await owner.fiber.dispose();
  assert.equal(native.get('fs'), fs); assert.equal(native.get('subprocess'), subprocess);
  console.log('PASS explicit local dispatch: zero bootstrap, SSH connector and remote skill preparation calls; borrowed providers survive owner disposal');
} finally { await owner.fiber.dispose(); await native.fiber.dispose(); await rm(directory, { recursive: true }); }
