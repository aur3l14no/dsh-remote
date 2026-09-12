import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { RemoteError } from '../../client/src/index.ts';

export interface Artifact { sha256: string; bytes: number }
export interface TargetPlatform {
  os: 'linux' | 'macos';
  arch: 'aarch64' | 'x86_64';
  abi: { kind: 'musl-static' } | { kind: 'glibc'; minimum: string } | { kind: 'darwin' };
}
export interface Bundle {
  target: TargetPlatform;
  helper: { version: string; api: 2; artifact: Artifact };
  ripgrep: { version: string; artifact: Artifact };
}
export interface Manifest { format: 1; bundles: Bundle[] }
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const fail = (message: string): never => { throw new RemoteError('INVALID_MANIFEST', message); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected manifest object');
  return value as Record<string, unknown>;
};
const version = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 80 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value)) return fail('Invalid artifact version');
  return value;
};
const artifact = (value: unknown): Artifact => {
  const a = object(value);
  if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || (a.bytes as number) < 1 || (a.bytes as number) > MAX_ARTIFACT_BYTES) return fail('Invalid artifact hash or size');
  return { sha256: a.sha256, bytes: a.bytes as number };
};

/** A manifest is trusted input supplied by the caller, never downloaded from a target. */
export function parseManifest(value: unknown): Manifest {
  const m = object(value);
  if (m.format !== 1 || !Array.isArray(m.bundles) || !m.bundles.length || m.bundles.length > 64) return fail('Unsupported manifest format or bundle count');
  const bundles = m.bundles.map(value => {
    const b = object(value), t = object(b.target), abi = object(t.abi), helper = object(b.helper), rg = object(b.ripgrep);
    if (!['linux', 'macos'].includes(t.os as string) || !['aarch64', 'x86_64'].includes(t.arch as string)) return fail('Unsupported target');
    let targetAbi: TargetPlatform['abi'];
    if (t.os === 'macos' && abi.kind === 'darwin') targetAbi = { kind: 'darwin' };
    else if (t.os === 'linux' && abi.kind === 'musl-static') targetAbi = { kind: 'musl-static' };
    else if (t.os === 'linux' && abi.kind === 'glibc' && typeof abi.minimum === 'string' && /^\d{1,3}\.\d{1,3}$/.test(abi.minimum)) targetAbi = { kind: 'glibc', minimum: abi.minimum };
    else return fail('Invalid target ABI');
    if (helper.api !== 2) return fail('Only helper API 2 is supported');
    return { target: { os: t.os, arch: t.arch, abi: targetAbi } as TargetPlatform,
      helper: { version: version(helper.version), api: 2 as const, artifact: artifact(helper.artifact) },
      ripgrep: { version: version(rg.version), artifact: artifact(rg.artifact) } };
  });
  if (new Set(bundles.map(bundleKey)).size !== bundles.length) return fail('Duplicate bundle');
  return { format: 1, bundles };
}

export function bundleKey(bundle: Bundle): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

export function selectBundle(manifest: Manifest, platform: { os: string; arch: string; glibc?: string }): Bundle {
  const candidates = manifest.bundles.filter(b => b.target.os === platform.os && b.target.arch === platform.arch && (
    b.target.abi.kind !== 'glibc' || (platform.glibc && atLeast(platform.glibc, b.target.abi.minimum))));
  if (candidates.length !== 1) throw new RemoteError('UNSUPPORTED_PLATFORM', candidates.length ? 'Ambiguous compatible bundles; select a release manifest' : 'No compatible helper/ripgrep bundle');
  return candidates[0]!;
}
function atLeast(actual: string, minimum: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}$/.test(actual)) return false;
  const [a, b] = actual.split('.').map(Number), [c, d] = minimum.split('.').map(Number);
  return a! > c! || (a === c && b! >= d!);
}

/** Copy an explicitly supplied artifact into a local content-addressed cache. No network trust policy is inferred. */
export async function cacheArtifact(source: string, cacheDir: string, expected?: Artifact): Promise<Artifact> {
  if (!isAbsolute(source) || !isAbsolute(cacheDir)) throw new RemoteError('INVALID_ARGUMENT', 'Artifact source/cache paths must be absolute');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const temporary = join(cacheDir, `.stage-${randomUUID()}`);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) throw new RemoteError('ARTIFACT_INVALID', 'Expected bounded regular artifact file');
    const output = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > MAX_ARTIFACT_BYTES) throw new RemoteError('ARTIFACT_INVALID', 'Artifact grew beyond limit');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      const result = { sha256: hash.digest('hex'), bytes };
      if (!bytes || (expected && (expected.bytes !== bytes || expected.sha256 !== result.sha256))) throw new RemoteError('ARTIFACT_MISMATCH', 'Local artifact differs from trusted manifest');
      await output.sync(); await output.chmod(0o400);
      await rename(temporary, join(cacheDir, result.sha256));
      return result;
    } finally { await output.close(); }
  } finally { await input.close(); await rm(temporary, { force: true }); }
}
