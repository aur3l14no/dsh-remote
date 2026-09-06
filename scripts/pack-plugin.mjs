import { build } from 'esbuild';
import ts from 'typescript';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { mkdir, cp, rm } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? '');
const baseline = 'd347e703908d0406b7a7ef80e3a0e594d86b2215';
if (!process.argv[2]) throw new Error('Usage: node scripts/pack-plugin.mjs DSH_SOURCE_CHECKOUT');
if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== baseline) throw new Error('Unexpected DSH source baseline');
if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('DSH source must be unmodified');
const source = resolve('packages');
const output = resolve('target/plugin');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const manifest = JSON.parse(readFileSync('packaging/plugin.package.json', 'utf8'));
writeFileSync(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp('packaging/README.md', join(output, 'README.md'));
await cp('LICENSE', join(output, 'LICENSE'));
// Bundle only this project's implementation. DSH/Cordis retain their host-owned identity.
const result = await build({
  entryPoints: { ...Object.fromEntries(Object.entries({ worlds: 'worlds', routing: 'routing', fs: 'routed-fs', subprocess: 'routed-subprocess', bindings: 'bindings' })
    .map(([entry, file]) => [entry, join(source, 'dsh-ssh/src', `${file}.ts`)])), client: join(source, 'client/src/index.ts') },
  outdir: join(output, 'lib'), bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24',
  packages: 'external', metafile: true,
});
if (Object.keys(result.metafile.inputs).some(file => file.includes('node_modules') || !resolve(file).startsWith(source + '/'))) {
  throw new Error('Plugin bundle contains code outside this project');
}
const upstream = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(upstream).map(([name, values]) => [name, values.map(value => {
  const path = resolve(root, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
const own = Object.keys(result.metafile.inputs).map(file => resolve(file));
const program = ts.createProgram(own, {
  target: ts.ScriptTarget.ES2024, lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts'], module: ts.ModuleKind.NodeNext,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, allowImportingTsExtensions: true,
  paths, types: ['node'], typeRoots: [resolve('node_modules/@types')],
});
const errors = ts.getPreEmitDiagnostics(program).filter(d => !d.file || d.file.fileName.startsWith(source + '/'));
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
}));
// Emit public declarations plus this project's relative type dependencies, never upstream declarations.
for (const file of program.getSourceFiles().filter(file => file.fileName.startsWith(source + '/'))) {
  program.emit(file, (_name, content) => {
    const target = join(output, 'types', relative(source, file.fileName).replace(/\.ts$/, '.d.ts'));
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }, undefined, true);
}
await mkdir('target/packages', { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', output, '--json', '--ignore-scripts', '--pack-destination', resolve('target/packages'), '--cache', '/tmp/dsh-remote-npm-cache'], { encoding: 'utf8' }))[0];
for (const file of packed.files) {
  if (!/^(lib\/.*\.js|types\/.*\.d\.ts|package\.json|README\.md|LICENSE)$/.test(file.path)) throw new Error(`Unexpected package file: ${file.path}`);
}
writeFileSync('target/packages/plugin-build.json', JSON.stringify({ dshSourceRevision: baseline, package: packed.filename,
  integrity: packed.integrity, files: packed.files, inputs: Object.keys(result.metafile.inputs) }, null, 2) + '\n');
console.log(`Built ${packed.filename}: ${packed.files.length} files; DSH/Cordis remain external`);
