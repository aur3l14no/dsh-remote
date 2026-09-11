import ts from 'typescript';
import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const root = resolve('.');
const upstream = resolve(process.argv[2] ?? '.build/dsh/extension-source');
const raw = ts.readConfigFile(join(upstream, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, values.map(value => {
  const file = resolve(upstream, value);
  return existsSync(file) && statSync(file).isDirectory() ? join(file, 'index.ts') : file;
})]));
// Published subpaths not present in the upstream source-mode facade.
for (const name of ['ui-workspace', 'ui-sidebar', 'ui-layout', 'locale']) {
  paths[`@deepseek-ai/dsh-client-${name}/client`] = [join(upstream, `packages/client/${name}/src/client/index.ts`)];
}
// The native directory-picker RPC face is generated only in the published package.
paths['@deepseek-ai/dsh-api-workspace-controller/remote'] = [join(root, '.build/dsh/official-install/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.d.ts')];
paths.react = [join(root, 'node_modules/@types/react/index.d.ts')];
paths['react/jsx-runtime'] = [join(root, 'node_modules/@types/react/jsx-runtime.d.ts')];
paths['@deepseek-ai/dsh-api-workspace-controller/types'] = [join(upstream, 'packages/api/workspace-controller/src/types.ts')];
paths['@deepseek-ai/dsh-client-file-upload/types'] = [join(upstream, 'packages/client/file-upload/src/types.ts')];
const format = { getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n' };
let failures = 0;
for (const entry of ['world/execution-world/src/presets.ts', 'workspace/remote-attachments/src/index.ts', 'bundle/remote/src/index.ts', 'workspace/portable-workspace/src/client/index.tsx', 'skill/remote-skills/src/deploy.ts', 'world/ssh-world/src/terminal-backend.ts']) {
  const program = ts.createProgram([join(root, 'integrations/dsh/packages', entry), join(upstream, 'packages/client/ui-sidebar/src/css-modules.d.ts')], {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, jsx: ts.JsxEmit.ReactJSX,
    strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, paths,
    lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts'],
    types: ['node'], typeRoots: [join(root, 'node_modules/@types')],
  });
  // Own downstream diagnostics and the patched sidebar browser surface.
  const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => !diagnostic.file
    || ['integrations/', 'runtime/'].some(path => diagnostic.file.fileName.startsWith(join(root, path)))
    || (diagnostic.file.fileName.startsWith(join(upstream, 'packages/client/ui-sidebar/src/'))
      // Pinned upstream references this absent locale key in its unchanged brand fallback.
      && !(diagnostic.code === 2345 && ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').includes('brand.localBuild'))));
  if (errors.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, format));
  failures += errors.length;
}
if (failures) process.exitCode = 1;
else console.log('PASS remote Web plugin host and client source types');
