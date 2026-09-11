import { writeFileSync, existsSync, statSync } from 'node:fs';
import { access, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { baselineRevision } from './baseline.mjs';
import { preparePatchedSource } from './prepare-patched-source.mjs';

const upstream = process.argv[2];
if (!upstream) throw new Error('Usage: node integrations/dsh/scripts/check-patched-host.mjs DSH_SOURCE [CANDIDATE_PATCH]');
const output = resolve('.build/dsh/patched-host');
const root = join(output, 'source');
const applied = await preparePatchedSource(upstream, root, process.argv.slice(3));
const rawPaths = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(rawPaths).map(([name, values]) => [name, values.map(value => {
  const path = resolve(root, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
for (const name of ['agent', 'commands', 'model-selection-projection']) paths[`@dsh-test/web-${name}`] = [join(root, 'packages/api/session-controller/src', name + '.ts')];
// Source checkout exposes this published type subpath through its package exports.
paths['@deepseek-ai/dsh-client-file-upload/types'] = [join(root, 'packages/client/file-upload/src/types.ts')];
const entry = resolve('integrations/dsh/tests/patched-host/admission.ts');
const preview = join(root, 'packages/api/workspace-files/src/index.ts');
const deliverables = join(root, 'packages/client/ui-deliverables/src/index.ts');
const program = ts.createProgram([entry, preview, deliverables], {
  target: ts.ScriptTarget.ES2024, lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts'], module: ts.ModuleKind.NodeNext,
  strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, paths,
  types: ['node'], typeRoots: [resolve('node_modules/@types')],
});
// Changed host package and our integration are this gate's type surface, not the whole upstream tree.
const checked = [join(root, 'packages/workspace/workspace/src/'), join(root, 'packages/interaction/permission-presets/src/'), join(root, 'packages/api/session-controller/src/'), join(root, 'packages/api/workspace-files/src/'), join(root, 'packages/client/ui-deliverables/src/'), resolve('integrations/dsh') + '/', resolve('runtime') + '/'];
const errors = ts.getPreEmitDiagnostics(program).filter(d => !d.file || checked.some(path => d.file.fileName.startsWith(path)));
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n',
}));
await copyFile(join(root, 'packages/llm/llm/package.json'), join(output, 'package.json'));
await build({ entryPoints: [entry], outfile: join(output, 'lib/admission.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node24', sourcemap: true, packages: 'external', external: ['@vscode/ripgrep', 'node-addon-require-builtin'],
  plugins: [{ name: 'patched-host-source', setup(builder) {
    builder.onResolve({ filter: /^(@deepseek-ai\/|@dsh-test\/web-)/ }, async ({ path }) => {
      const entry = paths[path]?.[0];
      if (!entry) return undefined;
      for (const candidate of [entry, entry + '.ts', join(entry, 'index.ts')]) {
        try { await access(candidate); if (candidate.endsWith('.ts')) return { path: candidate }; } catch {}
      }
      throw new Error(`Missing source: ${path}`);
    });
  } }],
});
writeFileSync(join(output, 'admission.mjs'), "import './lib/admission.mjs';\n");
writeFileSync(join(output, 'build.json'), JSON.stringify({ revision: baselineRevision, patches: applied, candidate: !!process.argv[3] }, null, 2) + '\n');
console.log('PASS patched host applied, typechecked and bundled; run .build/dsh/patched-host/admission.mjs for behavior acceptance');
