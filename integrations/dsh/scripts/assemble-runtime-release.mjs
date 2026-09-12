import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseManifest, cacheArtifact } from '../../../runtime/ssh/src/manifest.ts';

const [buildFile, platformsArg, output, ...extra] = process.argv.slice(2);
if (!buildFile || !platformsArg || !output || extra.length) throw new Error('Usage: assemble-runtime-release.mjs EXTENSION_BUILD.json PLATFORMS_DIRECTORY OUTPUT_DIRECTORY');
const platforms = resolve(platformsArg);
const build = JSON.parse(await readFile(buildFile, 'utf8'));
await mkdir(dirname(resolve(output)), { recursive: true });
const staging = await mkdtemp(join(dirname(resolve(output)), '.runtime-input-'));
try {
  const bundles = [];
  let license;
  for (const directory of await readdir(platforms)) {
    const root = join(platforms, directory);
    const source = JSON.parse(await readFile(join(root, 'source.json'), 'utf8'));
    if (source.revision !== build.sourceRevision || source.dirty !== build.sourceDirty) throw new Error('Runtime and extension source identities differ');
    const manifest = parseManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
    if (manifest.bundles.length !== 1) throw new Error('Expected one bundle per platform build');
    bundles.push(...manifest.bundles);
    for (const bundle of manifest.bundles) for (const artifact of [bundle.helper.artifact, bundle.ripgrep.artifact]) {
      await cacheArtifact(join(root, 'artifacts', artifact.sha256), join(staging, 'artifacts'), artifact);
    }
    const text = await readFile(join(root, 'LICENSE-RIPGREP'), 'utf8');
    if (license !== undefined && license !== text) throw new Error('Platform ripgrep licenses differ');
    license = text;
  }
  const keys = bundles.map(b => `${b.target.os}/${b.target.arch}/${b.target.abi.kind}`).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['linux/aarch64/musl-static', 'linux/x86_64/musl-static', 'macos/aarch64/darwin'])) throw new Error('Release requires Linux musl x86_64/aarch64 and macOS aarch64');
  if (new Set(bundles.map(b => `${b.helper.version}/${b.helper.api}/${b.ripgrep.version}`)).size !== 1) throw new Error('Platform component versions differ');
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(parseManifest({ format: 1, bundles }), null, 2));
  await writeFile(join(staging, 'LICENSE-RIPGREP'), license);
  execFileSync(process.execPath, ['integrations/dsh/scripts/pack-release.mjs', buildFile, join(staging, 'manifest.json'), join(staging, 'artifacts'), join(staging, 'LICENSE-RIPGREP'), output], { stdio: 'inherit' });

} finally { await rm(staging, { recursive: true, force: true }); }
