import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertUnchangedSource, baselineRevision } from './baseline.mjs';

const source = process.argv[2];
if (!source) throw new Error('Usage: node integrations/dsh/scripts/prepare-web-host.mjs DSH_SOURCE [--production] [CANDIDATE_PATCH]');
assertUnchangedSource(source);
const root = resolve('target/web-host');
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
const patches = [...series.patches];
const production = process.argv.includes('--production');
for (const file of process.argv.slice(3).filter(value => value !== '--production')) patches.push({ file });
// Only this disposable, script-owned checkout is replaced; the source stays pristine.
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const archive = execFileSync('git', ['-C', resolve(source), 'archive', baselineRevision], { maxBuffer: 128 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
const applied = [];
for (const patch of patches) {
  if (!/^[\w.-]+\.patch$/.test(patch.file)) throw new Error('Invalid patch filename');
  const file = resolve('integrations/dsh/patches', patch.file);
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  if (patch.sha256 && patch.sha256 !== sha256) throw new Error(`Patch checksum mismatch: ${patch.file}`);
  execFileSync('git', ['apply', '--no-index', file], { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(root, '..') } });
  applied.push({ file: patch.file, sha256 });
}
if (!production) execFileSync('git', ['apply', '--no-index', resolve('integrations/dsh/tests/e2e/scaffold.patch')], { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(root, '..') } });
const run = args => execFileSync('pnpm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true', DSH_CLIENT_COMMIT_HASH: baselineRevision, GIT_CEILING_DIRECTORIES: resolve(root, '..') } });
run(['install', '--frozen-lockfile']);
run(['run', 'build']);
if (!production) run(['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', 'chromium']);
await writeFile(join(root, 'remote-build.json'), JSON.stringify({ revision: baselineRevision, patches: applied, scaffold: production ? false : 'test-only' }, null, 2) + '\n');
execFileSync(process.execPath, [resolve('integrations/dsh/scripts/build-web-plugin.mjs'), root], { stdio: 'inherit' });
