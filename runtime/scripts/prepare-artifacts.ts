import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cacheArtifact, parseManifest } from '../ssh/src/manifest.ts';

const { values } = parseArgs({ options: Object.fromEntries([
  'os', 'arch', 'abi', 'minimum-glibc', 'helper', 'helper-version', 'ripgrep', 'ripgrep-version', 'cache', 'out',
].map(name => [name, { type: 'string' as const }])) });
const required = (key: string): string => {
  if (!values[key]) throw new Error(`Missing --${key}`);
  return values[key]!;
};
const cache = resolve(required('cache'));
// Preparing a manifest makes a trust assertion about caller-supplied files; no target binary executes locally.
const placeholder = { bytes: 1, sha256: '0'.repeat(64) };
const manifest = parseManifest({ format: 1, bundles: [{
  target: { os: required('os'), arch: required('arch'), abi: { kind: required('abi'), ...(values['minimum-glibc'] ? { minimum: values['minimum-glibc'] } : {}) } },
  helper: { version: required('helper-version'), api: 1, artifact: placeholder },
  ripgrep: { version: required('ripgrep-version'), artifact: placeholder },
}] });
const bundle = manifest.bundles[0]!;
bundle.helper.artifact = await cacheArtifact(resolve(required('helper')), cache);
bundle.ripgrep.artifact = await cacheArtifact(resolve(required('ripgrep')), cache);
await writeFile(resolve(required('out')), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Prepared platform manifest and verified local artifact cache');
