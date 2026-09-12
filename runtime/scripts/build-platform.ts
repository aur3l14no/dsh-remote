/** Build release artifacts for a supported target. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { cacheArtifact, parseManifest } from '../ssh/src/manifest.ts';

const targets = {
  'x86_64-unknown-linux-musl': { os: 'linux', arch: 'x86_64', abi: 'musl-static', sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' },
  'aarch64-unknown-linux-musl': { os: 'linux', arch: 'aarch64', abi: 'musl-static', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' },
  'aarch64-apple-darwin': { os: 'macos', arch: 'aarch64', abi: 'darwin', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' },
} as const;
const [target, outputArg, ...extra] = process.argv.slice(2);
if (!target || !(target in targets) || !outputArg || extra.length) throw new Error('Usage: build-platform.ts RUST_TARGET OUTPUT_DIRECTORY');
const spec = targets[target as keyof typeof targets];
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const run = (file: string, args: string[], cwd?: string) => execFileSync(file, args, { cwd, stdio: 'inherit' });
if (spec.os === 'linux') run('sh', ['runtime/helper/scripts/build-linux.sh', target]);
else run('cargo', ['build', '--locked', '--release', '--bins', '--target', target], 'runtime/helper');
const bin = resolve('runtime/helper/target', target, 'release');
const archive = join(output, 'ripgrep.tar.gz');
const rgVersion = '15.2.0';
const prefix = `ripgrep-${rgVersion}-${target}`;
try {
  const response = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}/${prefix}.tar.gz`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`ripgrep download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('ripgrep archive digest mismatch');
  await writeFile(archive, bytes);
  for (const [name, member] of [['rg', 'rg'], ['LICENSE-RIPGREP', 'COPYING']]) {
    await writeFile(join(output, name!), execFileSync('tar', ['-xOf', archive, `${prefix}/${member}`], { maxBuffer: 32 * 1024 * 1024 }));
  }
} finally { await rm(archive, { force: true }); }
await chmod(join(output, 'rg'), 0o755);
for (const name of ['dsh-remote-helper', 'dsh-remote-fixture']) {
  await writeFile(join(output, name), await readFile(join(bin, name)), { mode: 0o755 });
}
const helperVersion = /^version\s*=\s*"([^"]+)"/m.exec(await readFile('runtime/helper/Cargo.toml', 'utf8'))![1];
const manifest = parseManifest({ format: 1, bundles: [{
  target: { os: spec.os, arch: spec.arch, abi: { kind: spec.abi } },
  helper: { version: helperVersion, api: 2, artifact: await cacheArtifact(join(output, 'dsh-remote-helper'), join(output, 'artifacts')) },
  ripgrep: { version: rgVersion, artifact: await cacheArtifact(join(output, 'rg'), join(output, 'artifacts')) },
}] });
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(output, 'source.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim() }) + '\n');
console.log(`Prepared ${spec.os}/${spec.arch} runtime artifacts`);
