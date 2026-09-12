import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [source, report, ...extra] = process.argv.slice(2);
if (!source || !report || extra.length) throw new Error('Usage: prepare-upstream.mjs NEW_SOURCE_DIRECTORY REPORT_DIRECTORY');
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const series = JSON.parse(readFileSync(resolve(repo, 'integrations/dsh/patches/series.json'), 'utf8'));
const patches = series.patches.map(patch => {
  if (!/^[\w.-]+\.patch$/.test(patch.file)) throw new Error('Invalid patch name');
  const file = resolve(repo, 'integrations/dsh/patches', patch.file);
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== patch.sha256) throw new Error(`Patch checksum mismatch: ${patch.file}`);
  return file;
});
mkdirSync(source); // A new checkout keeps analysis separate from development state.
const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'inherit' });
git('init');
git('fetch', '--depth=1', series.repository, series.revision);
git('checkout', '--detach', 'FETCH_HEAD');
for (const file of patches) git('apply', file);
mkdirSync(report, { recursive: true });
writeFileSync(resolve(report, 'series.json'), JSON.stringify(series, null, 2));
