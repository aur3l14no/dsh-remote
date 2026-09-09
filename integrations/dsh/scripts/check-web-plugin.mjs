import ts from 'typescript';
import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const root = resolve('.');
const upstream = resolve(process.argv[2] ?? 'target/extension-source');
const raw = ts.readConfigFile(join(upstream, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, values.map(value => {
  const file = resolve(upstream, value);
  return existsSync(file) && statSync(file).isDirectory() ? join(file, 'index.ts') : file;
})]));
// Published subpaths not present in the upstream source-mode facade.
for (const name of ['ui-workspace', 'ui-sidebar']) {
  paths[`@deepseek-ai/dsh-client-${name}/client`] = [join(upstream, `packages/client/${name}/src/client/index.ts`)];
}
paths.react = [join(root, 'node_modules/@types/react/index.d.ts')];
paths['react/jsx-runtime'] = [join(root, 'node_modules/@types/react/jsx-runtime.d.ts')];
paths['@deepseek-ai/dsh-api-workspace-controller/types'] = [join(upstream, 'packages/api/workspace-controller/src/types.ts')];
paths['@deepseek-ai/dsh-client-file-upload/types'] = [join(upstream, 'packages/client/file-upload/src/types.ts')];
const format = { getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n' };
let failures = 0;
for (const entry of ['bundle/remote/src/index.ts', 'workspace/portable-workspace/src/client/index.tsx', 'skill/remote-skills/src/deploy.ts', 'world/ssh-world/src/terminal-backend.ts']) {
  const program = ts.createProgram([join(root, 'integrations/dsh/packages', entry)], {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, jsx: ts.JsxEmit.ReactJSX,
    strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, paths,
    lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts'],
    types: ['node'], typeRoots: [join(root, 'node_modules/@types')],
  });
  // Upstream has its own complete build gate; this gate owns downstream source diagnostics.
  const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => !diagnostic.file
    || ['integrations/', 'runtime/'].some(path => diagnostic.file.fileName.startsWith(join(root, path))));
  if (errors.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, format));
  failures += errors.length;
}
if (failures) process.exitCode = 1;
else console.log('PASS remote Web plugin host and client source types');
