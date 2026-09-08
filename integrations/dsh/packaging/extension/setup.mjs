import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { BindingStore } from './bindings.js';

export function apply(ctx) {
  const require = createRequire(import.meta.url);
  const expected = JSON.parse(readFileSync(new URL('./extension.json', import.meta.url), 'utf8'));
  const official = require('@deepseek-ai/dsh/package.json');
  if (official.version !== expected.dshVersion) throw new Error(`Unsupported DSH ${official.version}; expected ${expected.dshVersion}`);
  for (const name of new Set(expected.patches.flatMap(patch => patch.packages))) {
    if (require(`${name}/package.json`).version !== expected.dshVersion) throw new Error(`Unsupported compatibility dependency: ${name}`);
  }
  const configFile = join(resolveDshHome(), 'remote/config.json');
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (error) { throw new Error(`Cannot read remote configuration at ${configFile}; run dsh plugin --profile web exec dsh-remote-config init WORLD_CONFIG.json`, { cause: error }); }
  new BindingStore(config.bindingFile);
  ctx.provide('remoteSetup', { config, roots: [{ path: fileURLToPath(new URL('./presets/', import.meta.url)), trust: 'system' }] });
}
