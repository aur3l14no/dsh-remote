import { readFileSync, existsSync, statSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

const source = resolve(process.argv[2] ?? '.build/dsh/patched-host/source');
const installation = resolve('.build/dsh/official-install');
if (!existsSync(join(installation, 'node_modules/sharp'))) throw new Error('Run prepare-official.mjs before the attachment gate');
const output = resolve('.build/dsh/attachment-check');
await mkdir(output, { recursive: true });
if (!existsSync(join(output, 'node_modules'))) await symlink(join(installation, 'node_modules'), join(output, 'node_modules'));
const raw = ts.readConfigFile(join(source, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, values.map(value => {
  const path = resolve(source, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
for (const name of ['agent', 'commands', 'model-selection-projection']) paths[`@dsh-test/web-${name}`] = [join(source, 'packages/api/session-controller/src', name + '.ts')];
paths['@deepseek-ai/dsh-client-file-upload/types'] = [join(source, 'packages/client/file-upload/src/types.ts')];
paths['*'] = [join(installation, 'node_modules/*')];
for (const name of ['sharp', '@earendil-works/pi-ai']) {
  const metadata = JSON.parse(readFileSync(join(installation, 'node_modules', name, 'package.json'), 'utf8'));
  paths[name] = [join(installation, 'node_modules', name, metadata.types)];
  for (const [subpath, target] of Object.entries(metadata.exports ?? {})) {
    if (subpath !== '.' && typeof target.types === 'string') paths[name + subpath.slice(1)] = [join(installation, 'node_modules', name, target.types)];
  }
}
const entry = resolve('integrations/dsh/tests/patched-host/attachments.ts');
const program = ts.createProgram([entry], {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts'], paths, types: ['node'], typeRoots: [resolve('node_modules/@types')],
});
const checked = [resolve('integrations/dsh'), resolve('runtime'), ...['attachment/attachment', 'attachment/attachment-local', 'llm/llm', 'llm/llm-deepseek', 'llm/llm-pi-ai', 'client/file-upload', 'fs/tool-fs', 'api/session-controller', 'session-query/session-log-export', 'subagent/subagent'].map(path => join(source, 'packages', path, 'src'))];
const errors = ts.getPreEmitDiagnostics(program).filter(error => !error.file || checked.some(path => error.file.fileName.startsWith(path + '/')));
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n' }));
await writeFile(join(output, 'package.json'), readFileSync(join(source, 'packages/llm/llm/package.json')));
await build({ entryPoints: [entry], outfile: join(output, 'lib/attachments.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
  packages: 'external', plugins: [{ name: 'attachment-source-gate', setup(builder) {
    builder.onResolve({ filter: /^(@deepseek-ai\/|@dsh-test\/)/ }, ({ path }) => {
      const entry = paths[path]?.[0];
      if (!entry) return undefined;
      for (const candidate of [entry, entry + '.ts', join(entry, 'index.ts')]) if (existsSync(candidate) && candidate.endsWith('.ts')) return { path: candidate };
      throw new Error(`Missing source ${path}`);
    });
  } }],
});
console.log('PASS attachment host seam and plugin types; run .build/dsh/attachment-check/lib/attachments.mjs for behavior acceptance');
