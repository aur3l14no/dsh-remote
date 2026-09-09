import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The user chooses a trusted release directory. Checksums detect corruption;
// they do not authenticate a release obtained from an untrusted source.
export async function verifyFile(file, expected) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > 128 * 1024 * 1024) {
    throw new Error('Invalid release file digest or size');
  }
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('Release file size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) throw new Error('Release file checksum mismatch');
  } finally { await input.close(); }
}

export async function readRelease(directory, parseManifest) {
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
  if (release.format !== 1 || !/^[a-f0-9]{40}$/.test(release.sourceRevision) || !/^[a-f0-9]{40}$/.test(release.upstreamRevision)
      || typeof release.sourceDirty !== 'boolean' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(release.dshVersion)
      || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(release.extensionVersion)
      || !/^dsh-remote-extension-[\w.+-]+\.tgz$/.test(release.extension?.filename)) throw new Error('Invalid release metadata');
  const manifest = parseManifest(release.manifest);
  await verifyFile(join(directory, release.extension.filename), release.extension);
  for (const bundle of manifest.bundles) {
    for (const item of [bundle.helper, bundle.ripgrep]) await verifyFile(join(directory, 'artifacts', item.artifact.sha256), item.artifact);
  }
  return { release, manifest };
}
