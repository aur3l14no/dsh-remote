import { build } from 'esbuild';
import ts from 'typescript';
import { resolve, join } from 'node:path';
import { mkdir, access, realpath, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const source = process.argv[2];
const suite = process.argv[3] ?? 'composition';
if (!['composition', 'agents', 'persistence', 'terminal'].includes(suite)) throw new Error('Unknown composition suite');
if (!source) throw new Error('Usage: node scripts/build-composition.mjs DSH_SOURCE_CHECKOUT');
const baseline = 'd347e703908d0406b7a7ef80e3a0e594d86b2215';
const root = resolve(source);
if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== baseline) throw new Error('Composition requires the documented DSH baseline');
if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('DSH source must be unmodified');
const config = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config;
const paths = config.compilerOptions.paths;
await mkdir('target/composition', { recursive: true });
// The LLM attribution module reads its package version relative to the built entry.
await copyFile(join(root, 'packages/llm/llm/package.json'), 'target/package.json');
await build({
  entryPoints: [`tests/integration/${suite}.ts`], outfile: `target/composition/${suite === 'composition' ? 'run' : suite}.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
  packages: 'external',
  external: ['@vscode/ripgrep', 'node-addon-require-builtin'],
  plugins: [{ name: 'pinned-dsh-source', setup(build) {
    build.onResolve({ filter: /^@dsh-test\/mock-adapter$/ }, () => ({ path: join(root, 'packages/core/agent-loop/tests/mock-adapter.ts') }));
    build.onResolve({ filter: /^@deepseek-ai\// }, async ({ path }) => {
      const entry = paths[path]?.[0];
      if (!entry) return undefined;
      const candidate = resolve(root, entry);
      for (const file of [candidate, `${candidate}.ts`, join(candidate, 'index.ts')]) {
        try { await access(file); if (file.endsWith('.ts')) return { path: await realpath(file) }; } catch {}
      }
      throw new Error(`Required DSH source is absent: ${entry}; expand the pinned checkout`);
    });
  } }],
});
console.log(`Built external Loader composition against DSH ${baseline}`);
