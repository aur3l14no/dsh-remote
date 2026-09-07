import ts from 'typescript';
import { existsSync, statSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdir, writeFile, symlink, rm, readFile, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const upstream = resolve(process.argv[2] ?? 'target/web-host');
const output = resolve('target/web-plugin');
await mkdir(output, { recursive: true });
const entries = {
  index: 'portable_workspace/src/index.ts',
  routing: 'ssh-world/src/routing.ts', fs: 'ssh-world/src/routed-fs.ts', subprocess: 'ssh-world/src/routed-subprocess.ts',
};
// Runtime/provider entries have no browser metadata. The UI package has exactly one Loader row.
const packages = [
  { directory: output, name: '@dsh-remote/web', entries, client: false },
  { directory: `${output}-ui`, name: '@dsh-remote/web-ui', entries: {}, client: true },
];
const names = ts.readConfigFile(join(upstream, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
for (const item of packages) {
  await rm(join(item.directory, 'lib'), { recursive: true, force: true });
  await rm(join(item.directory, 'node_modules'), { recursive: true, force: true });
  let built;
  const exports = item.client ? { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' }
    : { ...Object.fromEntries(Object.keys(entries).map(name => [name === 'index' ? '.' : `./${name}`, `./lib/${name}.js`])), './package.json': './package.json' };
  if (item.client) {
    await mkdir(join(item.directory, 'lib'), { recursive: true });
    await writeFile(join(item.directory, 'lib/index.js'), 'export function apply() {}\n');
    built = await build({ metafile: true, entryPoints: [resolve('integrations/dsh/plugins/portable_workspace/src/client/index.tsx')], outfile: join(item.directory, 'lib/client.js'),
      bundle: true, format: 'cjs', banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(item.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` }, footer: { js: 'return module.exports; } });' }, platform: 'browser', target: 'es2022', external: ['@deepseek-ai/*', 'react', 'react/*'], nodePaths: [join(upstream, 'packages/api/workspace-controller/node_modules')], jsx: 'automatic' });
  } else {
    built = await build({ metafile: true, entryPoints: Object.fromEntries(Object.entries(item.entries).map(([name, file]) => [name, resolve('integrations/dsh/plugins', file)])),
      outdir: join(item.directory, 'lib'), bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external' });
  }
  const required = new Set(Object.values(built.metafile.outputs).flatMap(file => file.imports)
    .filter(entry => entry.external && !entry.path.startsWith('node:'))
    .map(entry => entry.path.startsWith('@') ? entry.path.split('/').slice(0, 2).join('/') : entry.path.split('/')[0]));
  if (item.client) {
    for (const name of ['@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-renderer']) required.add(name);
  } else {
    const preset = await readFile('integrations/dsh/profiles/remote/agent.cordis.yml', 'utf8');
    for (const match of preset.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)) required.add(match[1]);
  }
  const dependencies = {};
  for (const name of [...required].sort()) {
    let packageDir;
    if (name.startsWith('@deepseek-ai/')) {
      const candidate = resolve(upstream, names[name]?.[0] ?? '');
      packageDir = existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : dirname(candidate);
      while (packageDir !== upstream && !existsSync(join(packageDir, 'package.json'))) packageDir = dirname(packageDir);
      if (packageDir === upstream) throw new Error(`Missing DSH package: ${name}`);
    } else {
      const candidates = [resolve('node_modules', name), join(upstream, 'apps/web/node_modules', name), join(upstream, 'packages/api/workspace-controller/node_modules', name)];
      packageDir = candidates.find(path => existsSync(join(path, 'package.json')));
      if (!packageDir) throw new Error(`Missing dependency: ${name}`);
    }
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    dependencies[name] = metadata.version;
    const link = join(item.directory, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(packageDir, link, 'dir');
  }
  await writeFile(join(item.directory, 'package.json'), JSON.stringify({ name: item.name, version: '0.1.0', type: 'module', exports, dependencies,
    ...(item.client ? { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-renderer'] } } } : {}) }, null, 2));

}
console.log('Built remote Web plugin and browser workspace UI; DSH dependencies remain host-owned');

const profile = resolve('target/web-profile');
await mkdir(join(profile, 'node_modules/@dsh-remote'), { recursive: true });
for (const [name, directory] of [['web', output], ['web-ui', `${output}-ui`]]) {
  for (const owner of [profile, upstream]) {
    const link = join(owner, 'node_modules/@dsh-remote', name);
    await mkdir(dirname(link), { recursive: true });
    await rm(link, { force: true }); await symlink(directory, link, 'dir');
  }
}
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: '@dsh-remote/web-profile', version: '0.1.0', private: true,
  dependencies: { '@dsh-remote/web': '0.1.0', '@dsh-remote/web-ui': '0.1.0' } }, null, 2));
await cp('integrations/dsh/profiles/remote', join(output, 'presets/remote'), { recursive: true });
