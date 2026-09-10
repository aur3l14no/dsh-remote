import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { BindingStore } from './bindings.js';
import { parseManifest } from './manifest.js';
import { releaseBootstrap } from './download.mjs';

export async function apply(ctx) {
  const require = createRequire(import.meta.url);
  const expected = JSON.parse(readFileSync(new URL('./extension.json', import.meta.url), 'utf8'));
  const official = require('@deepseek-ai/dsh/package.json');
  if (official.version !== expected.dshVersion) throw new Error(`Unsupported DSH ${official.version}; expected ${expected.dshVersion}`);
  for (const name of new Set(expected.patches.flatMap(patch => patch.packages))) {
    if (require(`${name}/package.json`).version !== expected.dshVersion) throw new Error(`Unsupported compatibility dependency: ${name}`);
  }
  const directory = join(resolveDshHome(), 'remote');
  const configFile = join(directory, 'config.json');
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Only a new state directory may create a new binding store. Missing existing state must fail.
    mkdirSync(directory, { mode: 0o700 });
    config = { worlds: [], bindingFile: join(directory, 'bindings.json') };
    BindingStore.create(config.bindingFile);
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  new BindingStore(config.bindingFile);
  // Human-editable catalog is separate from binding/runtime control state.
  const worldsFile = join(directory, 'worlds.json');
  let catalog;
  try { catalog = JSON.parse(readFileSync(worldsFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    catalog = { worlds: config.worlds };
    writeFileSync(worldsFile, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  if (!Array.isArray(catalog.worlds)) throw new Error('worlds.json requires a worlds array');
  config.worlds = catalog.worlds;
  config.worldsFile = worldsFile;
  const installed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  config.bootstrap ??= releaseBootstrap(directory, { ...expected, version: installed.version }, parseManifest);
  ctx.provide('remoteSetup', { config, roots: [{ path: fileURLToPath(new URL('./presets/', import.meta.url)), trust: 'system' }] });
}
