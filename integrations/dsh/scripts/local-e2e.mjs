import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve('.');
await mkdir('.build/dsh/e2e', { recursive: true });
await rm('artifacts/dsh/local-workspace-result.json', { force: true });
if (process.env.DSH_TEST_PORTABLE_WORKSPACE_CONFIG) await rm('artifacts/dsh/mixed-workspace-result.json', { force: true });
const state = await mkdtemp(resolve('.build/dsh/e2e/local-'));
try {
  const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', resolve('integrations/dsh/tests/e2e/installed.vitest.config.mjs'), 'apps/web/tests/local-workspace.e2e.ts'], {
    cwd: resolve('.build/dsh/browser-fixtures'), stdio: 'inherit', env: { ...process.env, CI: 'true', DSH_SNAPSHOT: 'replay', DSH_PERMISSION_MODE: 'workspace-write', DSH_TEST_INSTALL: resolve('.build/dsh/official-install'), DSH_TEST_EXTENSION: resolve('.build/dsh/plugin-home/profiles/web/node_modules/@dsh-remote/extension'), DSH_REMOTE_ROOT: root, DSH_REMOTE_STATE: state },
  });
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`Local acceptance exited ${code}`))); });
} finally { await rm(state, { recursive: true, force: true }); }
