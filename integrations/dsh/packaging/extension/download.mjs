import { mkdir, mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRelease } from './release.mjs';

const execute = promisify(execFile);
const limit = 128 * 1024 * 1024;

/** Distribution policy belongs to the extension, not the generic SSH runtime. */
export function releaseBootstrap(directory, expected, parseManifest, fetchRelease = fetch) {
  if (!/^\d+\.\d+\.\d+$/.test(expected.version)) throw new Error('Invalid extension release version');
  const destination = join(directory, 'releases', expected.version);
  const check = async path => {
    const result = await readRelease(path, parseManifest);
    if (result.release.extensionVersion !== expected.version || result.release.dshVersion !== expected.dshVersion
        || result.release.upstreamRevision !== expected.revision || result.release.sourceDirty) {
      throw new Error('Downloaded runtime does not match this extension');
    }
    return { manifest: result.manifest, cacheDir: join(path, 'artifacts') };
  };
  let pending;
  return () => pending ??= (async () => {
    try { return await check(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(join(directory, 'releases'), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(directory, 'releases/.download-'));
    try {
      const response = await fetchRelease(`https://github.com/aur3l14no/dsh-remote/releases/download/v${expected.version}/dsh-remote-linux-x86_64.tar.gz`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Runtime download failed (${response.status}); retry Connect when the release is available`);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error('Runtime download exceeds size limit');
        chunks.push(chunk);
      }
      const archive = join(staging, 'download.tar.gz');
      await writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
      // Extract only explicitly named files to stdout: no archive paths or links reach the host filesystem.
      const extract = async (name, maxBuffer = limit) => (await execute('tar', ['-xOf', archive, `./${name}`], { encoding: 'buffer', maxBuffer, timeout: 30000 })).stdout;
      const metadata = await extract('release.json', 1024 * 1024);
      const release = JSON.parse(metadata);
      const manifest = parseManifest(release.manifest);
      if (!/^dsh-remote-extension-\d+\.\d+\.\d+\.tgz$/.test(release.extension?.filename)) throw new Error('Invalid runtime release');
      await writeFile(join(staging, 'release.json'), metadata, { mode: 0o600 });
      await writeFile(join(staging, release.extension.filename), await extract(release.extension.filename), { mode: 0o600 });
      await mkdir(join(staging, 'artifacts'), { mode: 0o700 });
      for (const hash of new Set(manifest.bundles.flatMap(bundle => [bundle.helper.artifact.sha256, bundle.ripgrep.artifact.sha256]))) {
        await writeFile(join(staging, 'artifacts', hash), await extract(`artifacts/${hash}`), { mode: 0o600 });
      }
      for (const name of ['LICENSE', 'LICENSE-RIPGREP']) await writeFile(join(staging, name), await extract(name, 1024 * 1024), { mode: 0o600 });
      await check(staging);
      await rm(archive);
      try { await rename(staging, destination); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      return await check(destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  })().catch(error => { pending = undefined; throw error; });
}
