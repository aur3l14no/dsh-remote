import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseManifest, cacheArtifact } from '../../../runtime/ssh/src/manifest.ts';
import { readRelease } from '../packaging/extension/release.mjs';

const [buildFile, manifestFile, cache, rgLicense, output, ...extra] = process.argv.slice(2);
if (!output || extra.length) throw new Error('Usage: pack-release.mjs EXTENSION_BUILD.json MANIFEST.json CACHE RIPGREP_LICENSE OUTPUT_DIRECTORY');
const build = JSON.parse(await readFile(buildFile, 'utf8'));
const series = JSON.parse(await readFile(new URL('../patches/series.json', import.meta.url), 'utf8'));
if (build.revision !== series.revision || build.dshVersion !== series.release.version || !/^[a-f0-9]{40}$/.test(build.sourceRevision)
    || !/^dsh-remote-extension-[\w.+-]+\.tgz$/.test(build.filename)) throw new Error('Extension build does not match the pinned source/release');
const archive = await readFile(resolve(dirname(buildFile), build.filename));
if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== build.integrity) throw new Error('Extension tarball integrity mismatch');
const manifest = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')));
const directory = resolve(output);
await mkdir(directory); // Never overwrite an existing candidate or release.
try {
  for (const bundle of manifest.bundles) {
    for (const item of [bundle.helper, bundle.ripgrep]) await cacheArtifact(resolve(cache, item.artifact.sha256), join(directory, 'artifacts'), item.artifact);
  }
  await writeFile(join(directory, build.filename), archive, { flag: 'wx' });
  await cp(new URL('../../../LICENSE', import.meta.url), join(directory, 'LICENSE'));
  await cp(rgLicense, join(directory, 'LICENSE-RIPGREP'));
  const release = { format: 1, sourceRevision: build.sourceRevision, sourceDirty: build.sourceDirty,
    upstreamRevision: build.revision, dshVersion: build.dshVersion, extensionVersion: build.extensionVersion,
    extension: { filename: build.filename, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }, manifest };
  await writeFile(join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  await readRelease(directory, parseManifest);
  const files = [build.filename, 'release.json', 'LICENSE', 'LICENSE-RIPGREP', ...new Set(manifest.bundles.flatMap(bundle =>
    [bundle.helper, bundle.ripgrep].map(item => `artifacts/${item.artifact.sha256}`)))];
  await writeFile(join(directory, 'SHA256SUMS'), (await Promise.all(files.map(async file =>
    `${createHash('sha256').update(await readFile(join(directory, file))).digest('hex')}  ${file}`))).join('\n') + '\n');
  console.log('Prepared release directory with verified extension, runtime artifacts and licenses');
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
