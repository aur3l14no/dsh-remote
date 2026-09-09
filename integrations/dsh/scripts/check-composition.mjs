import { assertUnchangedSource } from './baseline.mjs';
import ts from 'typescript';
import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
const source = process.argv[2];
if (!source) throw new Error('Usage: node integrations/dsh/scripts/check-composition.mjs DSH_SOURCE_CHECKOUT');
const root = resolve(source), local = resolve('integrations/dsh/packages/world/ssh-world');
assertUnchangedSource(root);
const upstream = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(upstream).map(([key, values]) => [key, values.map(value => {
  const path = resolve(root, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
paths['@dsh-test/mock-adapter'] = [join(root, 'packages/core/agent-loop/tests/mock-adapter.ts')];
for (const name of ['agent', 'commands', 'model-selection-projection']) paths[`@dsh-test/web-${name}`] = [join(root, 'packages/api/session-controller/src', name + '.ts')];
const program = ts.createProgram([...['world', 'context', 'fs', 'subprocess', 'terminal', 'bindings', 'worlds', 'routing'].map(name => join(local, 'src', name + '.ts')), ...['composition', 'remote-runtime', 'agents', 'preset-harness', 'terminal-consumers', 'terminal', 'session-routing', 'portable_workspace'].map(name => resolve('integrations/dsh/tests/integration', name + '.ts'))], {
  target: ts.ScriptTarget.ES2024, lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts'], module: ts.ModuleKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true,
  allowImportingTsExtensions: true, paths, types: ['node'], typeRoots: [resolve('node_modules/@types')],
});
// Check our providers against the pinned source interfaces. Upstream owns its full repository gate.
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || ['runtime/client', 'runtime/ssh', 'integrations/dsh/plugins', 'integrations/dsh/experiments', 'integrations/dsh/tests'].some(dir => d.file.fileName.startsWith(resolve(dir) + '/')));
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log('External providers typecheck against the pinned DSH source interfaces');
