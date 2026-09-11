import { baselineRevision, assertUnchangedSource } from './baseline.mjs';
import { build } from 'esbuild';
import ts from 'typescript';
import { mkdir, readFile, rm, access } from 'node:fs/promises';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Host fixture from unchanged DSH sources. Only our plugin is under package acceptance here.
const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node integrations/dsh/scripts/check-plugin.mjs DSH_SOURCE_CHECKOUT');
const buildRecord = JSON.parse(await readFile('.build/dsh/fixture-packages/plugin-build.json', 'utf8'));
assertUnchangedSource(root);
if (buildRecord.dshSourceRevision !== baselineRevision) throw new Error('Plugin build baseline changed');
const output = resolve('.build/dsh/package-check');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
const plugin = join(output, 'node_modules/@dsh-remote/ssh-world');
await mkdir(plugin, { recursive: true });
execFileSync('tar', ['-xf', resolve('.build/dsh/fixture-packages', buildRecord.package), '--strip-components=1', '-C', plugin]);
// The bundled LLM attribution code resolves ../package.json from lib/.
writeFileSync(join(output, 'package.json'), await readFile(join(root, 'packages/llm/llm/package.json')));
const paths = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths;
const consumer = join(output, 'consumer.ts');
writeFileSync(consumer, `import WorldService, { type Config, type WorldConnector } from '@dsh-remote/ssh-world';
import FsRouter from '@dsh-remote/ssh-world/fs';
import SubprocessRouter from '@dsh-remote/ssh-world/subprocess';
import { executionWorldContext } from '@dsh-remote/ssh-world/routing';
import { BindingStore } from '@dsh-remote/ssh-world/bindings';
import type { WorkspaceDefinition } from '@dsh-remote/ssh-world/identity';
import { Client } from '@dsh-remote/ssh-world/client';
import type { Context } from '@deepseek-ai/cordis';
const definition: WorkspaceDefinition = { id: 'example', worldId: 'example-world', kind: 'ssh', host: 'example.invalid', cwd: '/workspace', podmanContainer: 'a'.repeat(64) };
const config: Config = { bindingFile: '/private/bindings.json', packagedRipgrep: '/managed/rg', bootstrap: { manifest: {}, cacheDir: '/cache' } };
declare const ctx: Context;
const connector: WorldConnector = async () => { throw new Error('type check only'); };
const service = new WorldService(ctx, config, connector);
const selected: Promise<WorkspaceDefinition> = service.bind('example-session', definition);
void [selected, FsRouter, SubprocessRouter, executionWorldContext, BindingStore, Client];
`);
const typePaths = Object.fromEntries(Object.entries(paths).map(([name, values]) => [name, values.map(value => {
  const path = resolve(root, value);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.ts') : path;
})]));
const program = ts.createProgram([consumer], { target: ts.ScriptTarget.ES2024, lib: ['lib.es2024.d.ts', 'lib.esnext.array.d.ts'],
  module: ts.ModuleKind.NodeNext, strict: true, noEmit: true, paths: typePaths, types: ['node'], typeRoots: [resolve('node_modules/@types')] });
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || d.file.fileName.startsWith(output + '/'));
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
}));
console.log('Installed plugin exports and declarations typecheck against the pinned DSH interfaces');
const hostPeers = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-scope'];
const sourceAlias = { name: 'host-source-only', setup(builder) {
  builder.onResolve({ filter: /^@dsh-test\/mock-adapter$/ }, () => ({ path: join(root, 'packages/core/agent-loop/tests/mock-adapter.ts') }));
  builder.onResolve({ filter: /^@deepseek-ai\// }, async ({ path }) => {
    if (hostPeers.includes(path)) return { path, external: true };
    const entry = paths[path]?.[0];
    if (!entry) return undefined;
    for (const file of [resolve(root, entry), resolve(root, entry) + '.ts', join(root, entry, 'index.ts')]) {
      try { await access(file); if (file.endsWith('.ts')) return { path: file }; } catch {}
    }
    throw new Error(`Missing DSH fixture source: ${path}`);
  });
} };
// Keep identity-bearing host modules external and shared by the host fixture and installed plugin.
for (const name of hostPeers) {
  const directory = join(output, 'node_modules', name);
  await mkdir(join(directory, 'lib'), { recursive: true });
  const metadata = JSON.parse(await readFile(join(root, paths[name][0], '../package.json'), 'utf8'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: metadata.version, private: true, type: 'module', exports: './lib/index.js' }));
  await build({ entryPoints: [join(root, paths[name][0], 'index.ts')], outfile: join(directory, 'lib/index.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', plugins: [sourceAlias] });
}
const remotes = new Map([
  [resolve('integrations/dsh/packages/world/execution-world/src/worlds.ts'), '@dsh-remote/ssh-world'],
  [resolve('integrations/dsh/packages/world/execution-world/src/routing.ts'), '@dsh-remote/ssh-world/routing'],
  [resolve('integrations/dsh/packages/world/execution-world/src/bindings.ts'), '@dsh-remote/ssh-world/bindings'],
  [resolve('runtime/client/src/index.ts'), '@dsh-remote/ssh-world/client'],
]);
const result = await build({ entryPoints: ['integrations/dsh/tests/integration/session-routing.ts'], outfile: join(output, 'lib/accept.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', metafile: true,
  plugins: [{ name: 'installed-plugin', setup(builder) {
    builder.onResolve({ filter: /(?:execution-world|ssh-world|client)\/src\// }, ({ path, resolveDir }) => {
      const entry = remotes.get(resolve(resolveDir, path));
      if (!entry) throw new Error(`Package fixture must not import a private plugin source: ${path}`);
      return { path: entry, external: true };
    });
  } }, sourceAlias],
});
if (Object.keys(result.metafile.inputs).some(file => file.includes('integrations/dsh/packages/world/'))) throw new Error('Host fixture bundled plugin source');
const external = new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(i => i.external).map(i => i.path)));
for (const name of remotes.values()) if (!external.has(name)) throw new Error(`Fixture did not consume package entry: ${name}`);
writeFileSync(join(output, 'accept.mjs'), "import './lib/accept.mjs';\n");
console.log(`Unpacked plugin and prepared pinned-source host: ${join(output, 'accept.mjs')}`);
