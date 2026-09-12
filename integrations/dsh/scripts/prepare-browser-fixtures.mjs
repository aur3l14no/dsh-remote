import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
const source = resolve(process.argv[2] ?? '.build/dsh/extension-source');
const output = resolve('.build/dsh/browser-fixtures');
await rm(output, { recursive: true, force: true });
const files = ['apps/web/tests/scaffold.ts', 'apps/web/tests/support.ts', 'packages/core/agent-loop/tests/mock-adapter.ts', 'snapshots/web/web-search-round'];
for (const file of files) { await mkdir(dirname(join(output, file)), { recursive: true }); await cp(join(source, file), join(output, file), { recursive: true }); }
const replace = (text, before, after) => { if (!text.includes(before)) throw new Error(`Upstream fixture changed: ${before}`); return text.replace(before, after); };
const path = join(output, 'apps/web/tests/scaffold.ts');
let scaffold = await readFile(path, 'utf8');
scaffold = "import { createRequire } from 'node:module'\nconst installedRequire = createRequire(process.env.DSH_TEST_INSTALL + '/package.json')\n" + scaffold;
for (const [before, after] of [
  ["join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')", "installedRequire.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')"],
  ["join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')", "installedRequire.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')"],
  ["join(REPO_ROOT, 'apps/cli/package.json')", "installedRequire.resolve('@deepseek-ai/dsh/package.json')"],
  ["{ id: 'llm-deepseek', disabled: true }", "{ id: composedRows.some(row => row.id === 'remote-llm-deepseek') ? 'remote-llm-deepseek' : 'llm-deepseek', disabled: true }"],
  ['export interface LaunchOptions {', 'export interface LaunchOptions {\n  persistentStateRoot?: string\n  directoryPicking?: boolean'],
  ['config: { root: persistenceRoot }', "config: { root: options.persistentStateRoot === undefined ? persistenceRoot : join(options.persistentStateRoot, 'sessions') }"],
  ["root: join(workspaceCwd, '.dsh-storages')", "root: join(options.persistentStateRoot ?? workspaceCwd, '.dsh-storages')"],
  ["    { insert: [\n      { id: 'directory-picker-browse'", "    ...(options.directoryPicking === false ? [] : [{ insert: [\n      { id: 'directory-picker-browse'"],
  ["name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },\n    ] },", "name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },\n    ] }]),"],
]) scaffold = replace(scaffold, before, after);
await writeFile(path, scaffold);
const support = join(output, 'apps/web/tests/support.ts');
await writeFile(support, replace(await readFile(support, 'utf8'), "fileURLToPath(new URL('../dist/index.html', import.meta.url))", "process.env.DSH_TEST_INSTALL + '/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'"));
for (const [from, to] of [['conversation-history.mjs', 'conversation-history.mjs'], ['local-workspace.e2e.ts', 'local-workspace.e2e.ts'], ['attachments.e2e.ts', 'attachments.e2e.ts'], ['file-preview.ts', 'remote-file-preview.ts'], ['portable-workspace.e2e.ts', 'portable-workspace.e2e.ts'], ['ssh-approval.e2e.ts', 'ssh-approval.e2e.ts'], ['live.e2e.ts', 'remote-live.e2e.ts'], ['children.ts', 'remote-children.ts'], ['replay.ts', 'remote-replay.ts']]) {
  await cp(`integrations/dsh/tests/e2e/${from}`, join(output, 'apps/web/tests', to));
}
console.log('Prepared upstream test fixtures only; runtime packages and frontend come from the official installation');
