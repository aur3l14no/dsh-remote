import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { build } from 'esbuild';

const [sourceArg, installationArg] = process.argv.slice(2);
if (!sourceArg || !installationArg) throw new Error('Usage: build-extension.mjs PINNED_DSH_SOURCE OFFICIAL_INSTALL');
const source = resolve(sourceArg), installation = resolve(installationArg);
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
const version = series.release.version;
const revision = series.revision;
if (JSON.parse(await readFile(join(installation, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version !== version) throw new Error('Wrong official DSH installation');
const output = resolve('target/extension');
const sources = resolve('target/extension-source');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
await rm(sources, { recursive: true, force: true }); await mkdir(sources, { recursive: true });
execFileSync('tar', ['-xf', '-', '-C', sources], { input: execFileSync('git', ['-C', source, 'archive', revision], { maxBuffer: 128 * 1024 * 1024 }) });
for (const patch of series.patches) {
  const file = resolve('integrations/dsh/patches', patch.file);
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== patch.sha256) throw new Error('Patch checksum mismatch');
  execFileSync('git', ['apply', '--no-index', file], { cwd: sources, env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(sources, '..') } });
}
const compatibilityNames = new Set(series.patches.flatMap(patch => patch.packages));
const packages = [];
const patchedSources = [];
for (const name of new Set(series.patches.flatMap(patch => patch.packages))) {
  const official = join(installation, 'node_modules', name);
  const metadata = JSON.parse(await readFile(join(official, 'package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error(`Wrong official package: ${name}`);
  const directory = `compat/${name}`;
  patchedSources.push({ source: join(sources, metadata.repository.directory, 'src'), destination: join(output, directory, 'lib/types') });
  packages.push(directory);
  await cp(official, join(output, directory), { recursive: true, filter: path => !path.slice(official.length).split('/').includes('node_modules') });
  await build({ entryPoints: [join(sources, metadata.repository.directory, 'src/index.ts')], outfile: join(output, directory, 'lib/index.js'),
    bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external',
    plugins: [{ name: 'typescript', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\// }, args => compatibilityNames.has(args.path) ? {
        path: './' + relative(join(output, directory, 'lib'), join(output, 'compat', args.path, 'lib/index.js')), external: true,
      } : undefined);
      builder.onLoad({ filter: /\.ts$/ }, args => ({
      contents: ts.transpileModule(readFileSync(args.path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, loader: 'js',
    })); } }],
  });
}
// Keep shipped declarations consistent with the compatibility implementation.
// Type correctness is checked by the separate patched-host and plugin gates.
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(sources, 'tsconfig.base.json'), ts.sys.readFile).config, ts.sys, sources);
const program = ts.createProgram(patchedSources.map(item => join(item.source, 'index.ts')), {
  ...parsed.options, composite: false, incremental: false, noEmit: false, declaration: true, declarationMap: false,
  emitDeclarationOnly: true, rootDir: sources, outDir: join(output, '.types'), rewriteRelativeImportExtensions: true,
});
for (const file of program.getSourceFiles()) {
  const owner = patchedSources.find(item => file.fileName.startsWith(item.source + '/'));
  if (!owner || file.isDeclarationFile) continue;
  let declaration;
  program.emit(file, (path, content) => { if (path.endsWith('.d.ts')) declaration = content; }, undefined, true);
  if (declaration === undefined) throw new Error(`Could not emit compatibility declaration: ${file.fileName}`);
  const destination = join(owner.destination, relative(owner.source, file.fileName).replace(/\.ts$/, '.d.ts'));
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, declaration);
}
const entries = { index: 'portable_workspace/src/index.ts', terminal: 'terminal/src/index.ts', routing: 'ssh-world/src/routing.ts', fs: 'ssh-world/src/routed-fs.ts', subprocess: 'ssh-world/src/routed-subprocess.ts' };
const dependencies = { '@deepseek-ai/dsh-home-paths': version, '@deepseek-ai/dsh-tool-terminal': version, 'js-yaml': '4.3.2' };
for (const browser of [false, true]) {
  const name = browser ? 'web-ui' : 'web';
  const directory = `plugins/${name}`;
  packages.push(directory);
  const dest = join(output, directory);
  await mkdir(join(dest, 'lib'), { recursive: true });
  const built = browser ? await build({ entryPoints: ['integrations/dsh/plugins/portable_workspace/src/client/index.tsx'], outfile: join(dest, 'lib/client.js'),
    bundle: true, metafile: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['@deepseek-ai/*', 'react', 'react/*'],
    banner: { js: `window.__ModuleLoader__.load({ id: "@dsh-remote/web-ui", factory: (require) => { var module = { exports: {} }; var exports = module.exports;` }, footer: { js: 'return module.exports; } });' },
  }) : await build({ entryPoints: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, `integrations/dsh/plugins/${path}`])), outdir: join(dest, 'lib'), bundle: true, splitting: true, metafile: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external' });
  for (const imported of Object.values(built.metafile.outputs).flatMap(file => file.imports)) {
    if (!imported.external || imported.path.startsWith('node:') || imported.path.startsWith('@deepseek-ai/') || imported.path.startsWith('react')) continue;
    const name = imported.path.startsWith('@') ? imported.path.split('/').slice(0, 2).join('/') : imported.path.split('/')[0];
    dependencies[name] = JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8')).version;
  }
  if (browser) await writeFile(join(dest, 'lib/index.js'), 'export function apply() {}\n');
  await writeFile(join(dest, 'package.json'), JSON.stringify({ name: `@dsh-remote/${name}`, version: '0.2.0', type: 'module',
    exports: browser ? { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' } : { ...Object.fromEntries(Object.keys(entries).map(key => [key === 'index' ? '.' : `./${key}`, `./lib/${key}.js`])), './package.json': './package.json' },
    ...(browser ? { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-renderer'] } } } : {}),
  }, null, 2));
}
await cp('integrations/dsh/profiles/remote', join(output, 'presets/remote'), { recursive: true });
await cp('integrations/dsh/packaging/extension', output, { recursive: true });
await cp('integrations/dsh/profiles/remote/cordis.patch.yml', join(output, 'cordis.patch.yml'));
await rm(join(output, 'presets/remote/cordis.patch.yml'));
await build({ entryPoints: ['integrations/dsh/plugins/ssh-world/src/bindings.ts'], outfile: join(output, 'bindings.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
await cp('LICENSE', join(output, 'LICENSE'));
await writeFile(join(output, 'extension.json'), JSON.stringify({ dshVersion: version, revision, patches: series.patches, packages }, null, 2));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@dsh-remote/extension', version: '0.2.0', type: 'module', license: 'MIT', engines: { node: '>=24.19.0' }, bin: { 'dsh-remote-config': './config.mjs' }, exports: { '.': './setup.mjs', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies }, null, 2));
await mkdir('target/packages', { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', output, '--json', '--ignore-scripts', '--pack-destination', resolve('target/packages'), '--cache', '/tmp/dsh-remote-npm-cache'], { encoding: 'utf8' }))[0];
if (packed.files.some(file => file.path.includes('node_modules') || file.path.includes('.local'))) throw new Error('Unexpected extension archive entry');
await writeFile('target/packages/extension-build.json', JSON.stringify({ revision, dshVersion: version, integrity: packed.integrity, filename: packed.filename }, null, 2));
console.log('Built seven compatibility packages and the remote extension; no DSH host/frontend build');
