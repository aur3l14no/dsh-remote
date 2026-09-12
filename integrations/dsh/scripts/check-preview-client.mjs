import ts from 'typescript';
import { globSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// Host and browser Context declarations must be checked in separate programs.
const source = resolve(process.argv[2] ?? '.build/dsh/extension-source');
const installation = resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install');
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
paths['pdfjs-dist'] = [resolve('node_modules/pdfjs-dist/types/src/pdf.d.ts')];
paths['picomatch/posix'] = [join(installation, 'node_modules/@types/picomatch/posix.d.ts')];
const entries = [];
for (const name of ['ui-tool', 'ui-chat', 'ui-sidebar-right', 'ui-deliverables', 'ui-sidebar-documentpreview']) {
  const directory = join(source, 'packages/client', name, 'src');
  paths[`@deepseek-ai/dsh-client-${name}/client`] = [join(directory, 'client/index.ts')];
  entries.push(join(directory, 'client/index.ts'), join(directory, 'css-modules.d.ts'));
}
entries.push(join(source, 'packages/client/ui-sidebar-documentpreview/src/client/pdf/asset-imports.d.ts'));
const program = ts.createProgram(entries, {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, jsx: ts.JsxEmit.ReactJSX,
  strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, paths,
  lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [], typeRoots: [resolve('node_modules/@types')],
});
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log('PASS patched Chat and Sidebar browser source against official client declarations');
