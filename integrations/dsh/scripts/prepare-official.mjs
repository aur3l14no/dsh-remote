import { mkdir, cp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const output = resolve(process.argv[2] ?? 'target/official-install');
const source = resolve('integrations/dsh/packaging/official');
const series = JSON.parse(await readFile('integrations/dsh/patches/series.json', 'utf8'));
const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
const host = lock.packages[`node_modules/${series.release.package}`];
if (host.version !== series.release.version || host.integrity !== series.release.integrity) throw new Error('Official lock does not match the selected release');
await mkdir(output, { recursive: true });
for (const file of ['package.json', 'package-lock.json']) await cp(join(source, file), join(output, file));
execFileSync('npm', ['ci', '--prefix', output, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
// The remote profile needs DSH's file locking addon, but never the native
// local subprocess/desktop backends. Build only the required official addon.
execFileSync('npm', ['rebuild', '--prefix', output, 'fs-ext'], { stdio: 'inherit' });
console.log('Installed locked official DSH and test support; no DSH source build');
