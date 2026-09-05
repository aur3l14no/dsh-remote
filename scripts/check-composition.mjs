import ts from 'typescript';
import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/check-composition.mjs DSH_SOURCE_CHECKOUT');
const root = resolve(source), local = resolve('packages/dsh-ssh');
const upstream = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(upstream).map(([key, values]) => [key, values.map(value => {
  const path = resolve(root, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
const program = ts.createProgram(['world', 'fs', 'subprocess'].map(name => join(local, 'src', name + '.ts')), {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true,
  allowImportingTsExtensions: true, paths, types: ['node'], typeRoots: [resolve('node_modules/@types')],
});
// Check our providers against the pinned source interfaces. Upstream owns its full repository gate.
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || d.file.fileName.startsWith(resolve('packages') + '/'));
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log('External providers typecheck against the pinned DSH source interfaces');
