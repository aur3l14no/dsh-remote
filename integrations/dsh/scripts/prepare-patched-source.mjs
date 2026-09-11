import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { assertUnchangedSource, baselineRevision } from './baseline.mjs';

// Gates own separate output trees; only the deterministic preparation is shared.
export async function preparePatchedSource(upstream, output, candidates = []) {
  assertUnchangedSource(upstream);
  const series = JSON.parse(readFileSync(new URL('../patches/series.json', import.meta.url), 'utf8'));
  const patches = [...series.patches, ...candidates.map(file => ({ file }))];
  const applied = patches.map(patch => {
    if (!/^[\w.-]+\.patch$/.test(patch.file)) throw new Error('Patch must name a file in integrations/dsh/patches');
    const file = resolve('integrations/dsh/patches', patch.file);
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (patch.sha256 && patch.sha256 !== sha256) throw new Error(`Patch checksum mismatch: ${patch.file}`);
    return { file: patch.file, sha256 };
  });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const archive = execFileSync('git', ['-C', resolve(upstream), 'archive', baselineRevision], { maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', output], { input: archive });
  for (const patch of applied) {
    const file = resolve('integrations/dsh/patches', patch.file);
    const options = { cwd: output, env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(output, '..') } };
    execFileSync('git', ['apply', '--no-index', '--check', file], options);
    execFileSync('git', ['apply', '--no-index', file], options);
  }
  return applied;
}
