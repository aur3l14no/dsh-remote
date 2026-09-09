import ts from 'typescript';
import { globSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// Host and browser Context declarations must be checked in separate programs.
const source = resolve(process.argv[2] ?? 'target/extension-source');
const installation = resolve(process.env.DSH_TEST_INSTALL ?? 'target/official-install');
const paths = {};
for (const manifest of globSync('node_modules/@deepseek-ai/*/package.json', { cwd: installation })) {
  const file = join(installation, manifest);
  const metadata = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(metadata.exports ?? {})) {
    const types = typeof value === 'object' && value !== null ? value.types : undefined;
    if (typeof types === 'string') paths[metadata.name + (key === '.' ? '' : key.slice(1))] = [resolve(dirname(file), types)];
  }
}
for (const name of ['react', 'react-dom']) paths[name] = [resolve(`node_modules/@types/${name}/index.d.ts`)];
paths['react/jsx-runtime'] = [resolve('node_modules/@types/react/jsx-runtime.d.ts')];
const directory = join(source, 'packages/client/ui-chat/src');
paths['@deepseek-ai/dsh-client-ui-chat/client'] = [join(directory, 'client/index.ts')];
const program = ts.createProgram([join(directory, 'client/index.ts'), join(directory, 'css-modules.d.ts')], {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, jsx: ts.JsxEmit.ReactJSX,
  strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, paths,
  lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [], typeRoots: [resolve('node_modules/@types')],
});
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log('PASS patched Chat browser source against official client declarations');
