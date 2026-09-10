import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const installed = createRequire(resolve('.build/dsh/official-install/package.json'));
const cordis = installed.resolve('@deepseek-ai/cordis');
const { Context } = await import(pathToFileURL(cordis));
const output = resolve('.build/dsh/navigation-check/navigation.mjs');
await mkdir(resolve('.build/dsh/navigation-check'), { recursive: true });
await build({ entryPoints: ['integrations/dsh/packages/workspace/portable-workspace/src/client/navigation.ts'], outfile: output,
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  plugins: [{ name: 'official-cordis', setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\/cordis$/ }, () => ({ path: cordis, external: true }));
  } }],
});
const { Navigation } = await import(pathToFileURL(output));

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(initial = '') {
  const previous = { location: globalThis.location, history: globalThis.history };
  globalThis.location = new URL(`https://workspace.test/${initial}`);
  globalThis.history = { replaceState(_state, _unused, value) { globalThis.location = new URL(value); } };
  const ctx = new Context();
  const listeners = new Set();
  const state = { phase: 'ready', current: undefined, byId: {}, ids: [] };
  const created = [], opened = [], forks = [];
  let currentNavigation = new AbortController();
  let panel = 'settings';
  const layout = {
    beginNavigation() { currentNavigation.abort(); currentNavigation = new AbortController(); return currentNavigation.signal; },
    selectPanel(id) { currentNavigation.abort(); panel = id; },
  };
  const workspaces = { phase: 'ready', archivedSessionIds: [], items: [
    { workspaceId: 'a', path: '/workspace', sessionIds: ['blank-a'] },
    { workspaceId: 'b', path: '/workspace', sessionIds: [] },
  ] };
  const notify = () => { for (const listener of listeners) listener(); };
  ctx.provide('layout', layout);
  ctx.provide('workspaces', { list: { getSnapshot: () => workspaces }, archiveSession: async id => { workspaces.archivedSessionIds.push(id); } });
  ctx.provide('sessions', {
    list: { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    create(options) { const result = deferred(); created.push({ options, ...result }); return result.promise; },
    fork(options) { const result = deferred(); forks.push({ options, ...result }); return result.promise; },
    open(id) { opened.push(id); state.current = id; notify(); },
    clear() { state.current = undefined; notify(); },
  });
  const navigation = new Navigation(ctx);
  return { navigation, state, workspaces, layout, created, opened, forks, get panel() { return panel; }, notify,
    async close() {
      try { await ctx.fiber.dispose(); } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
        }
      }
    },
  };
}

test('same-path Worlds only reuse their own blank Session and deduplicate creation', async () => {
  const f = await fixture();
  try {
    f.state.byId['blank-a'] = { blank: true, cwd: '/workspace' };
    assert.equal(await f.navigation.connectWorkspace('a'), 'blank-a');
    const first = f.navigation.connectWorkspace('b'), second = f.navigation.connectWorkspace('b');
    assert.equal(f.created.length, 1);
    assert.deepEqual(f.created[0].options, { workspaceId: 'b' });
    f.created[0].resolve('created-b');
    assert.deepEqual(await Promise.all([first, second]), ['created-b', 'created-b']);
    await assert.rejects(f.navigation.connectWorkspace('unknown'), /unavailable/);
  } finally { await f.close(); }
});

test('workspace and fork completion cannot replace a later panel or Session selection', async () => {
  const f = await fixture();
  try {
    let transferred = false;
    const opening = f.navigation.openWorkspace('b', () => { transferred = true; });
    f.layout.selectPanel('settings');
    f.created[0].resolve('created-b');
    await opening;
    assert.equal(transferred, false);
    assert.deepEqual(f.opened, []);
    assert.equal(f.panel, 'settings');
    const forking = f.navigation.forkSession('source-a');
    f.navigation.openSession('different-b');
    f.forks[0].resolve('fork-a');
    await forking;
    assert.deepEqual(f.opened, ['different-b']);
    assert.equal(f.panel, null);
    assert.equal(new URL(location.href).searchParams.get('session'), 'different-b');
  } finally { await f.close(); }
});

test('current navigation transfers draft preparation before showing the Conversation', async () => {
  const f = await fixture();
  try {
    const opening = f.navigation.openWorkspace('b', id => {
      assert.equal(id, 'created-b');
      assert.equal(f.panel, 'settings');
      assert.deepEqual(f.opened, []);
    });
    f.created[0].resolve('created-b');
    await opening;
    assert.deepEqual(f.opened, ['created-b']);
    assert.equal(f.panel, null);
    const forking = f.navigation.forkSession('created-b');
    f.forks[0].resolve('fork-b');
    await forking;
    assert.deepEqual(f.opened, ['created-b', 'fork-b']);
  } finally { await f.close(); }
});

test('unavailable deep links stay explicit and disposal cancels pending UI selection', async () => {
  const f = await fixture('?session=missing');
  try {
    assert.equal(f.navigation.unavailableSession, 'missing');
    assert.equal(new URL(location.href).searchParams.get('session'), 'missing');
    const opening = f.navigation.openWorkspace('b');
    await f.close();
    f.created[0].resolve('created-b');
    await opening;
    assert.deepEqual(f.opened, []);
  } finally { await f.close(); }
});

test('registration completion respects a newer panel', async () => {
  const f = await fixture();
  try {
    const registration = deferred();
    const opening = f.navigation.registerWorkspace(() => registration.promise);
    f.layout.selectPanel('settings');
    registration.resolve('b');
    await opening;
    assert.deepEqual(f.opened, []);
    assert.equal(f.created.length, 0);
    assert.equal(f.panel, 'settings');
  } finally { await f.close(); }
});
