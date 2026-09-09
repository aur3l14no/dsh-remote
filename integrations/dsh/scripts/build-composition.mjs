import { baselineRevision as baseline, assertUnchangedSource } from './baseline.mjs';
import { build } from 'esbuild';
import ts from 'typescript';
import { resolve, join } from 'node:path';
import { mkdir, access, realpath, copyFile, writeFile } from 'node:fs/promises';

const source = process.argv[2];
const suite = process.argv[3] ?? 'composition';
if (!['composition', 'agents', 'terminal', 'session-routing', 'portable_workspace'].includes(suite)) throw new Error('Unknown composition suite');
if (!source) throw new Error('Usage: node integrations/dsh/scripts/build-composition.mjs DSH_SOURCE_CHECKOUT');
const root = resolve(source);
assertUnchangedSource(root);
const config = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config;
const paths = config.compilerOptions.paths;
await mkdir('.build/dsh/composition', { recursive: true });
// The LLM attribution module reads its package version relative to the built entry.
await copyFile(join(root, 'packages/llm/llm/package.json'), '.build/dsh/composition/package.json');
await build({
  entryPoints: [`integrations/dsh/tests/integration/${suite}.ts`], outfile: `.build/dsh/composition/lib/${suite === 'composition' ? 'run' : suite}.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
  packages: 'external',
  external: ['@vscode/ripgrep', 'node-addon-require-builtin'],
  plugins: [{ name: 'pinned-dsh-source', setup(build) {
    build.onResolve({ filter: /^@dsh-test\/mock-adapter$/ }, () => ({ path: join(root, 'packages/core/agent-loop/tests/mock-adapter.ts') }));
    // Test witnesses for the unchanged Web activation path; never imported by our plugins.
    build.onResolve({ filter: /^@dsh-test\/web-(agent|commands|model-selection-projection)$/ }, ({ path }) => ({
      path: join(root, 'packages/api/session-controller/src', path.slice('@dsh-test/web-'.length) + '.ts'),
    }));
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
await writeFile(`.build/dsh/composition/${suite === 'composition' ? 'run' : suite}.mjs`, `import './lib/${suite === 'composition' ? 'run' : suite}.mjs';\n`);
console.log(`Built external Loader composition against DSH ${baseline}`);
