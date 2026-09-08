#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { BindingStore } from './bindings.js';

const [action, input, ...extra] = process.argv.slice(2);
if (action !== 'init' || !input || extra.length) throw new Error('Usage: dsh-remote-config init WORLD_CONFIG.json');
const config = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!Array.isArray(config.worlds) || !config.bootstrap || config.bindingFile) throw new Error('Configuration requires worlds and bootstrap, without bindingFile');
const directory = join(resolveDshHome(), 'remote');
await mkdir(directory, { mode: 0o700 });
config.bindingFile = join(directory, 'bindings.json');
BindingStore.create(config.bindingFile);
await writeFile(join(directory, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Initialized remote configuration. Start with the official dsh --profile web command.');
