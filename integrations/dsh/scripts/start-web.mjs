import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { BindingStore } from '../plugins/ssh-world/src/bindings.ts';

// Source installation: paths stay anchored to this checkout, regardless of cwd.
const root = resolve(import.meta.dirname, '../../..');
const host = join(root, 'target/web-host');
const [action, homeArgument, ...args] = process.argv.slice(2);
if (!['init', 'start'].includes(action) || !homeArgument || (action === 'init' && args.length !== 1)) {
  throw new Error('Usage: start-web.mjs init NEW_PRIVATE_HOME WORLD_CONFIG.json | start PRIVATE_HOME [Web CLI flags]');
}
const home = resolve(homeArgument);
const series = JSON.parse(await readFile(join(root, 'integrations/dsh/patches/series.json'), 'utf8'));
const build = JSON.parse(await readFile(join(host, 'remote-build.json'), 'utf8'));
if (build.revision !== series.revision || JSON.stringify(build.patches) !== JSON.stringify(series.patches.map(({ file, sha256 }) => ({ file, sha256 })))) {
  throw new Error('Stale source installation; run prepare-web-host.mjs with the pinned source');
}
if (action === 'init') {
  const config = JSON.parse(await readFile(resolve(args[0]), 'utf8'));
  if (!Array.isArray(config.worlds) || !config.bootstrap || config.bindingFile) {
    throw new Error('Configuration requires worlds and bootstrap, without an existing bindingFile');
  }
  // Exclusive creation prevents treating lost historical bindings as a fresh install.
  await mkdir(home, { mode: 0o700 });
  config.bindingFile = join(home, 'bindings.json');
  BindingStore.create(config.bindingFile);
  await writeFile(join(home, 'remote.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const profile = join(home, 'profiles/remote');
  await mkdir(join(profile, 'node_modules/@dsh-remote'), { recursive: true });
  const dependencies = {};
  for (const name of ['web', 'web-ui']) {
    const directory = join(root, `target/${name === 'web' ? 'web-plugin' : 'web-plugin-ui'}`);
    await symlink(directory, join(profile, 'node_modules/@dsh-remote', name), 'dir');
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    // Native preset entries resolve at the profile anchor, including consumers
    // (e.g. tool-terminal) absent from the CLI's own dependency closure.
    for (const [dependency, version] of Object.entries(metadata.dependencies)) {
      if (dependencies[dependency]) {
        if (dependencies[dependency] !== version) throw new Error(`Conflicting source dependency: ${dependency}`);
        continue;
      }
      dependencies[dependency] = version;
      const link = join(profile, 'node_modules', dependency);
      await mkdir(resolve(link, '..'), { recursive: true });
      await symlink(join(directory, 'node_modules', dependency), link, 'dir');
    }
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
    dependencies: { ...dependencies, '@dsh-remote/web': '0.1.0', '@dsh-remote/web-ui': '0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
  }, null, 2));
  const overlay = await readFile(join(root, 'integrations/dsh/profiles/remote/cordis.patch.yml'), 'utf8');
  // Preserve upstream's !!js config expression; serialize only the additional values.
  await writeFile(join(profile, 'cordis.patch.yml'), overlay + yaml.dump([{ id: 'agent-presets', config: {
    default: 'remote', roots: [{ path: join(root, 'target/web-plugin/presets'), trust: 'system' }],
  } }]), { mode: 0o600 });
  console.log(`Initialized ${home}. Configure model credentials there, then run start-web.mjs start with this directory.`);
} else {
  for (let index = 0; index < args.length; index++) {
    if (['--no-open', '--help'].includes(args[index])) continue;
    if (['--host', '--port', '--trusted-host'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('-')) { index++; continue; }
    throw new Error(`Unsupported Web startup argument: ${args[index]}`);
  }
  const config = JSON.parse(await readFile(join(home, 'remote.json'), 'utf8'));
  new BindingStore(config.bindingFile); // Startup never creates/replaces bindings.
  const child = spawn(process.execPath, ['--expose-internals', join(host, 'apps/cli/lib/bin.js'), '--profile', 'remote', ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_CONFIG: JSON.stringify(config) },
  });
  const forward = signal => { child.kill(signal); };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => accept(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
