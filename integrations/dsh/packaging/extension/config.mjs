#!/usr/bin/env node
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { BindingStore } from './bindings.js';
import { parseManifest, cacheArtifact } from './manifest.js';
import { readRelease } from './release.mjs';

const [action, input, worldsFile, ...extra] = process.argv.slice(2);
if (!input || extra.length || (action === 'init' ? worldsFile : action !== 'init-release' || !worldsFile)) {
  throw new Error('Usage: dsh-remote-config init WORLD_CONFIG.json | init-release RELEASE_DIRECTORY WORLDS.json');
}
const config = JSON.parse(await readFile(resolve(action === 'init' ? input : worldsFile), 'utf8'));
if (!Array.isArray(config.worlds) || !config.worlds.length || config.bindingFile) throw new Error('Configuration requires nonempty worlds, without bindingFile');
let release;
if (action === 'init-release') {
  if (config.bootstrap) throw new Error('init-release takes worlds without bootstrap');
  release = await readRelease(resolve(input), parseManifest);
  const expected = JSON.parse(await readFile(new URL('./extension.json', import.meta.url), 'utf8'));
  const installed = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  if (release.release.dshVersion !== expected.dshVersion || release.release.upstreamRevision !== expected.revision
      || release.release.extensionVersion !== installed.version) throw new Error('Release does not match the installed extension');
} else {
  if (!config.bootstrap) throw new Error('Configuration requires bootstrap');
  config.bootstrap.manifest = parseManifest(config.bootstrap.manifest);
}
const directory = join(resolveDshHome(), 'remote');
await mkdir(directory, { mode: 0o700 });
try {
  if (release) {
    const cacheDir = join(directory, 'artifacts');
    for (const bundle of release.manifest.bundles) {
      for (const item of [bundle.helper, bundle.ripgrep]) await cacheArtifact(resolve(input, 'artifacts', item.artifact.sha256), cacheDir, item.artifact);
    }
    config.bootstrap = { manifest: release.manifest, cacheDir };
  }
  config.bindingFile = join(directory, 'bindings.json');
  BindingStore.create(config.bindingFile);
  await writeFile(join(directory, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} catch (error) {
  await rm(directory, { recursive: true, force: true }); // Only the directory exclusively created by this invocation.
  throw error;
}
console.log('Initialized remote configuration. Start with the official dsh --profile web command.');
