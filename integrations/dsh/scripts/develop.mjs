import { existsSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { assertUnchangedSource } from './baseline.mjs';

const [task, ...extra] = process.argv.slice(2);
if (!['check', 'test-integration', 'test-e2e', 'package'].includes(task) || extra.length) {
  throw new Error('Usage: develop.mjs check|test-integration|test-e2e|package; set DSH_SOURCE to the clean pinned checkout');
}
const source = resolve(process.env.DSH_SOURCE ?? '.build/dsh/upstream');
const installation = resolve('.build/dsh/official-install');
if (!existsSync(join(source, 'tsconfig.base.json'))) {
  throw new Error(`Missing pinned DSH source at ${source}. Set DSH_SOURCE to a clean checkout of the revision in integrations/dsh/patches/series.json; see docs/development.md.`);
}
assertUnchangedSource(source);
if (!existsSync(join(installation, 'node_modules/@deepseek-ai/dsh/package.json'))) {
  throw new Error('Missing official DSH dependencies. Run node integrations/dsh/scripts/prepare-official.mjs once before this task.');
}
function run(command, args, env = process.env) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const node = (...args) => run(process.execPath, args);
const script = (name, ...args) => node(`integrations/dsh/scripts/${name}.mjs`, ...args);
const tests = (...patterns) => node('--test', ...patterns.flatMap(pattern => globSync(pattern)));
const patchedSource = resolve('.build/dsh/patched-host/source');
function patched() { script('check-patched-host', source); }
function packageExtension() { script('build-extension', source, installation); }

if (task === 'check') {
  run('npm', ['run', 'check:runtime']);
  script('check-composition', source);
  patched();
  script('check-web-plugin', patchedSource);
  script('check-preview-client', patchedSource);
  script('check-attachments', patchedSource);
} else if (task === 'package') {
  packageExtension();
} else if (task === 'test-integration') {
  if (!process.env.DSH_TEST_RG || !existsSync(process.env.DSH_TEST_RG)) {
    throw new Error('Set DSH_TEST_RG to the absolute path of a native ripgrep executable before test-integration.');
  }
  script('check-composition', source);
  for (const suite of ['composition', 'agents', 'terminal', 'session-routing', 'local-world', 'portable_workspace', 'shared-runtime']) {
    script('build-composition', source, suite);
    node(`.build/dsh/composition/${suite === 'composition' ? 'run' : suite}.mjs`);
  }
  script('pack-plugin', source);
  script('check-plugin', source);
  run(process.execPath, ['.build/dsh/package-check/accept.mjs'], { ...process.env, DSH_TEST_PACKAGED: '1' });
  patched();
  node('.build/dsh/patched-host/admission.mjs');
  node('.build/dsh/patched-host/lib/child-environment.mjs');
  script('check-attachments', patchedSource);
  node('--expose-internals', '.build/dsh/attachment-check/lib/attachments.mjs');
} else {
  script('build-composition', source, 'shared-runtime');
  // Prepare each shared build/profile/fixture once, then preserve each acceptance lane.
  patched();
  packageExtension();
  script('prepare-test-profile');
  script('check-web-plugin');
  script('check-preview-client');
  script('check-attachments');
  script('prepare-browser-fixtures');
  tests('integrations/dsh/tests/packaging/*.test.mjs', 'integrations/dsh/tests/client/*.test.mjs');
  script('local-e2e');
  script('e2e', '--suite');
}
