import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const installation = resolve(process.env.DSH_TEST_INSTALL ?? '.build/dsh/official-install');
const artifact = JSON.parse(await readFile('dist/dsh/extension-build.json', 'utf8'));
const home = resolve('.build/dsh/plugin-home');
await rm(home, { recursive: true, force: true });
await mkdir(home, { recursive: true, mode: 0o700 });
const bytes = await readFile(resolve('dist/dsh', artifact.filename));
const archive = join(home, `extension-${createHash('sha256').update(bytes).digest('hex')}.tgz`);
await writeFile(archive, bytes);
execFileSync(process.execPath, ['--expose-internals', join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'plugin', '--profile', 'web', 'add', archive], { env: { ...process.env, DSH_HOME: home }, stdio: 'inherit' });

// The scaffold imports this installed bundle from another private home; prepare
// the same official fallback that the production launcher establishes at boot.
const { healProfilesModuleFallback, loadProfile } = await import(join(installation, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'));
const installAnchor = join(installation, 'node_modules/@deepseek-ai/dsh/package.json');
await healProfilesModuleFallback({ installAnchor, home, profile: loadProfile('dsh', 'web', installAnchor, home) });
