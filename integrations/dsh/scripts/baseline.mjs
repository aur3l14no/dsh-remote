import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// One source of truth; unchanged-source gates never apply the downstream series.
export const { revision: baselineRevision } = JSON.parse(
  readFileSync(new URL('../patches/series.json', import.meta.url), 'utf8'),
);
export function assertUnchangedSource(root) {
  if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== baselineRevision) {
    throw new Error('Unexpected DSH source baseline');
  }
  if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
    throw new Error('DSH source must be unmodified; use a separate patched-host gate');
  }
}
