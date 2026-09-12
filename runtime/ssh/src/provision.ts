import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { RemoteError } from '../../client/src/index.ts';
import { bundleKey } from './manifest.ts';
import type { Artifact, Bundle } from './manifest.ts';
import type { Control, ControlOptions } from './control.ts';

export interface Probe { os: string; arch: string; glibc?: string; installRoot: string; home: string }
export interface Installation { root: string; generation: string; helper: string; ripgrep: string; reused: boolean; bundle: Bundle }
export function remotePath(value: string): string {
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) throw new RemoteError('INVALID_ARGUMENT', 'Bootstrap requires absolute paths without NUL or line breaks');
  return value;
}
const prelude = String.raw`
set -eu
set -f
umask 077
fail() { printf 'ERROR %s\n' "$1"; exit 0; }
`;
export async function script(control: Control, body: string, args: string[], options?: ControlOptions): Promise<string> {
  // String.raw preserves the escape needed to write shell ${...} inside a JS template.
  const result = await control(['sh', '-c', prelude + body.replaceAll('\\${', '${'), 'dsh-bootstrap', ...args], options);
  if (/^ERROR [A-Z_]+\n$/.test(result)) throw new RemoteError(result.trim().slice(6), 'Remote bootstrap refused the operation');
  return result;
}

export async function probe(control: Control, installRoot?: string, signal?: AbortSignal): Promise<Probe> {
  if (installRoot !== undefined) remotePath(installRoot);
  const result = await script(control, String.raw`
case $(uname -s) in Linux) os=linux;; Darwin) os=macos;; *) fail UNSUPPORTED_PLATFORM;; esac
case $(uname -m) in aarch64|arm64) arch=aarch64;; x86_64|amd64) arch=x86_64;; *) fail UNSUPPORTED_PLATFORM;; esac
libc=unknown
if [ "$os" = linux ]; then
  found=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  case "$found" in 'glibc '*) libc=\${found#glibc };; esac
fi
root=$1
if [ -z "$root" ]; then root="$HOME/.cache/dsh-remote"; fi
printf 'DSH-PROBE\n%s\n%s\n%s\n%s\n%s\n' "$os" "$arch" "$libc" "$root" "$HOME"
`, [installRoot ?? ''], { signal });
  const lines = result.split('\n');
  if (lines.length !== 7 || lines[0] !== 'DSH-PROBE') throw new RemoteError('CONTROL_PROTOCOL', 'Unexpected platform probe response');
  return { os: lines[1]!, arch: lines[2]!, ...(lines[3] !== 'unknown' ? { glibc: lines[3]! } : {}), installRoot: remotePath(lines[4]!), home: remotePath(lines[5]!) };
}

const filesystem = String.raw`
uid=$(id -u)
file_mode() {
  listing=$(LC_ALL=C ls -ldn "$1") || return 1
  set -- $listing
  case "$1" in drwx------) mode=700;; dr-x------|-r-x------) mode=500;; -r--------) mode=400;; *) return 1;; esac
  printf '%s:%s\n' "$3" "$mode"
}
private_mode() { [ ! -L "$1" ] && [ "$(file_mode "$1" 2>/dev/null)" = "$uid:$2" ]; }
private_dir() {
  [ ! -L "$1" ] || fail UNSAFE_INSTALL_ROOT
  if [ ! -e "$1" ]; then mkdir -p "$1" || fail INSTALL_UNWRITABLE; fi
  [ -d "$1" ] && private_mode "$1" 700 || fail UNSAFE_INSTALL_ROOT
}
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256; }
else fail HASH_UNAVAILABLE
fi
`;
const verify = String.raw`
valid_file() {
  [ -f "$1" ] && private_mode "$1" 500 || return 1
  actual_bytes=$(wc -c < "$1")
  [ "$actual_bytes" -eq "$2" ] || return 1
  actual_hash=$(sha < "$1")
  actual_hash=\${actual_hash%% *}
  [ "$actual_hash" = "$3" ]
}
valid_generation() {
  [ -d "$1" ] && private_mode "$1" 500 || return 1
  valid_file "$1/dsh-remote-helper" "$helper_bytes" "$helper_hash" && valid_file "$1/rg" "$rg_bytes" "$rg_hash"
}
lookup() {
  [ -f "$ref" ] && private_mode "$ref" 400 || return 1
  [ "$(wc -c < "$ref")" -le 64 ] || return 1
  IFS= read -r generation < "$ref" || return 1
  case "$generation" in g.*) ;; *) return 1;; esac
  case "$generation" in *[!A-Za-z0-9.]*) return 1;; esac
  [ "\${#generation}" -eq 10 ] || return 1
  valid_generation "$root/generations/$generation"
}
versions() {
  helper_version=$("$1/dsh-remote-helper" --version) || fail ARTIFACT_EXEC_FAILED
  [ "$helper_version" = "$expected_helper" ] || fail ARTIFACT_VERSION_MISMATCH
  rg_version=$("$1/rg" --version) || fail ARTIFACT_EXEC_FAILED
  rg_version=$(printf '%s\n' "$rg_version" | head -n 1)
  case "$rg_version" in "$expected_rg"|"$expected_rg (rev "*")") ;; *) fail ARTIFACT_VERSION_MISMATCH;; esac
}
root=$1; key=$2; helper_bytes=$3; helper_hash=$4; rg_bytes=$5; rg_hash=$6; expected_helper=$7; expected_rg=$8
ref="$root/refs/$key"
`;

/** Concurrent callers publish one checked generation. Running Worlds keep their exact generation path. */
export async function install(control: Control, info: Probe, bundle: Bundle, cacheDir: string, options: { signal?: AbortSignal; lockWaitMs?: number } = {}): Promise<Installation> {
  if (!isAbsolute(cacheDir)) throw new RemoteError('INVALID_ARGUMENT', 'Local artifact cache must be absolute');
  const lockWaitMs = options.lockWaitMs ?? 10000;
  if (!Number.isInteger(lockWaitMs) || lockWaitMs < 100 || lockWaitMs > 30000) throw new RemoteError('INVALID_ARGUMENT', 'Invalid installation lock deadline');
  const initialized = await script(control, filesystem + String.raw`
private_dir "$1"
root=$(cd "$1" && pwd -P)
for suffix in generations refs locks; do private_dir "$root/$suffix"; done
printf '%s\n' "$root"
`, [info.installRoot], { signal: options.signal });
  const root = remotePath(initialized.replace(/\n$/, ''));
  const args = [root, bundleKey(bundle), String(bundle.helper.artifact.bytes), bundle.helper.artifact.sha256,
    String(bundle.ripgrep.artifact.bytes), bundle.ripgrep.artifact.sha256,
    `dsh-remote-helper ${bundle.helper.version} api=${bundle.helper.api} ${bundle.target.arch}-${bundle.target.os}`,
    `ripgrep ${bundle.ripgrep.version}`];
  const result = (reply: string): Installation => {
    const match = /^(REUSED|INSTALLED) (g\.[A-Za-z0-9]{8})\n$/.exec(reply);
    if (!match) throw new RemoteError('CONTROL_PROTOCOL', 'Invalid installation response');
    const generation = match[2]!;
    return { root, generation, helper: `${root}/generations/${generation}/dsh-remote-helper`, ripgrep: `${root}/generations/${generation}/rg`, reused: match[1] === 'REUSED', bundle };
  };
  const found = await script(control, filesystem + verify + String.raw`
if lookup; then versions "$root/generations/$generation"; printf 'REUSED %s\n' "$generation"; else printf 'MISSING\n'; fi
`, args, { signal: options.signal });
  if (found !== 'MISSING\n') return result(found);
  const stage = remotePath((await script(control, filesystem + String.raw`
private_dir "$1/generations"
mktemp -d "$1/generations/g.XXXXXXXX"
`, [root], { signal: options.signal })).replace(/\n$/, ''));
  if (!new RegExp(`^g\\.[A-Za-z0-9]{8}$`).test(stage.slice(root.length + '/generations/'.length)) || !stage.startsWith(`${root}/generations/`)) throw new RemoteError('CONTROL_PROTOCOL', 'Invalid staging directory');
  let publishing = false;
  try {
    await upload(control, stage, 'dsh-remote-helper', bundle.helper.artifact, cacheDir, options.signal);
    await upload(control, stage, 'rg', bundle.ripgrep.artifact, cacheDir, options.signal);
    publishing = true; // After this point, only the remote transaction may decide whether stage is published.
    return result(await script(control, filesystem + verify + String.raw`
stage=$9; attempts=\${10}; lock="$root/locks/$key"; acquired=0; published=0; pointer=''
cleanup() {
  if [ "$published" = 0 ]; then
    # mv may have committed immediately before a signal, while this lock still excludes publishers.
    if [ -f "$ref" ] && [ "$(cat "$ref")" = "\${stage##*/}" ]; then published=1; fi
    if [ "$published" = 0 ]; then chmod 700 "$stage" 2>/dev/null || true; rm -rf "$stage"; fi
  fi
  if [ -n "$pointer" ]; then rm -f "$pointer"; fi
  if [ "$acquired" = 1 ]; then rmdir "$lock"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
while ! mkdir "$lock" 2>/dev/null; do
  attempts=$((attempts - 1))
  [ "$attempts" -gt 0 ] || fail INSTALL_BUSY
  sleep 1
done
acquired=1
if lookup; then versions "$root/generations/$generation"; printf 'REUSED %s\n' "$generation"; exit 0; fi
chmod 500 "$stage"
valid_generation "$stage" || fail ARTIFACT_MISMATCH
versions "$stage"
[ ! -L "$ref" ] && [ ! -d "$ref" ] || fail UNSAFE_INSTALL_ROOT
pointer=$(mktemp "$root/refs/.ref.XXXXXXXX")
printf '%s\n' "\${stage##*/}" > "$pointer"
chmod 400 "$pointer"
mv -f "$pointer" "$ref"
published=1
printf 'INSTALLED %s\n' "\${stage##*/}"
`, [...args, stage, String(Math.floor(lockWaitMs / 1000) + 1)], { signal: options.signal, timeoutMs: lockWaitMs + 20000 }));
  } finally {
    if (!publishing) await script(control, 'rm -rf "$1"\n', [stage], { timeoutMs: 10000 }).catch(() => {});
  }
}

async function upload(control: Control, stage: string, name: string, expected: Artifact, cacheDir: string, signal?: AbortSignal): Promise<void> {
  const file = await open(join(cacheDir, expected.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expected.bytes) throw new RemoteError('ARTIFACT_MISMATCH', 'Local cached artifact has wrong size');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: expected.bytes })) {
      signal?.throwIfAborted(); bytes += chunk.length; hash.update(chunk);
    }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new RemoteError('ARTIFACT_MISMATCH', 'Local cached artifact has wrong digest');
    await script(control, filesystem + String.raw`
[ -d "$1" ] && private_mode "$1" 700 || fail UNSAFE_INSTALL_ROOT
set -C
cat > "$1/$2"
chmod 500 "$1/$2"
printf 'UPLOADED\n'
`, [stage, name], { input: file.createReadStream({ autoClose: false, start: 0, end: expected.bytes - 1 }), signal, timeoutMs: 120000 });
  } finally { await file.close(); }
}
