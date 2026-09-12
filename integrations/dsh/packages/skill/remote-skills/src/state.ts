import { Readable } from 'node:stream';
import { sshControl } from '../../../../../../runtime/ssh/src/control.ts';
import type { SshTarget } from '../../../../../../runtime/ssh/src/transport.ts';

/** Utilities shared by deployment and read-only previews on GNU and BSD. */
export const skillUtilities = `
skill_sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
skill_mode() {
  case $(uname -s) in Darwin) stat -f %Lp "$1";; *) stat -c %a "$1";; esac
}
`;

/** Read-only content/mode fingerprint; identical to prepareSkills' portable manifest. */
export const skillStateProgram = `
${skillUtilities}
skill_manifest() {
  test -d "$1" && test ! -L "$1" || return 1
  manifest=$(cd "$1" && find . -exec sh -c '
    ${skillUtilities}
    for file do
      relative=\${file#./}; if [ "$file" = . ]; then relative=""; fi
      name=$(printf %s "$relative" | base64 | tr -d \"\\n\") || exit 1
      if [ -L "$file" ]; then exit 1
      elif [ -d "$file" ]; then printf "d %s\\n" "$name"
      elif [ -f "$file" ]; then
        mode=$(skill_mode "$file") || exit 1
        sum=$(skill_sha "$file") || exit 1
        sum=\${sum#\\\\}
        printf "f %s %s %s\\n" "$mode" "\${sum%% *}" "$name"
      else exit 1; fi
    done
  ' sh {} +) || return 1
  printf '%s\\n' "$manifest" | LC_ALL=C sort
}
skill_tree() {
  sorted=$(skill_manifest "$1") || return 1
  checksum=$(printf '%s\\n' "$sorted" | skill_sha)
  printf %s "\${checksum%% *}"
}
skill_state() {
  case "$HOME" in /*) ;; *) return 1;; esac
  link="$HOME/.agents/skills/$1"
  root="$HOME/.local/share/dsh-remote/skills"
  if [ -L "$link" ]; then
    destination=$(readlink "$link")
    case "$destination" in "$root/$1/"*) ;; *) echo 'error:Skill destination belongs to another manager'; return 1;; esac
    revision=\${destination##*/}
    case "$revision" in ''|*[!0-9a-f]*) echo 'error:Invalid managed revision'; return 1;; esac
    test \${#revision} -eq 64 && test "$destination" = "$root/$1/$revision" || return 1
    fingerprint=$(skill_tree "$destination") || { echo 'error:Managed skill is missing, unreadable or contains special files'; return 1; }
    printf '%s:%s' "$revision" "$fingerprint"
  elif [ -e "$link" ]; then
    echo 'error:Skill destination is not a managed symlink'; return 1
  else printf 'absent'; fi
}
`;

export async function inspectSkill(target: SshTarget, name: string, signal?: AbortSignal): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid skill name');
  const state = (await sshControl(target)(['sh', '-c', `set -eu\n${skillStateProgram}\nif value=$(skill_state "$1"); then printf %s "$value"; else printf 'error:%s' "$value"; fi`, 'dsh-skill-preview', name], { signal })).trim();
  if (state !== 'absent' && !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(state)) throw new Error(state.replace(/^(error:)+/, '') || 'Invalid remote skill state');
  return state;
}

/** Check a reused immutable version even when it is not currently enabled. */
export async function verifySkillVersion(target: SshTarget, name: string, revision: string, expected: string, signal?: AbortSignal) {
  const state = (await sshControl(target)(['sh', '-c', `set -eu
${skillStateProgram}
destination="$HOME/.local/share/dsh-remote/skills/$1/$2"
if [ -e "$destination" ] || [ -L "$destination" ]; then skill_tree "$destination"; else printf absent; fi
`, 'dsh-skill-version-preview', name, revision], { signal })).trim();
  if (state !== 'absent' && state !== expected) throw new Error(`Stored skill version has drifted: ${name}; repair it before applying`);
}

export async function removeSkill(target: SshTarget, name: string, expected: string, signal?: AbortSignal) {
  await sshControl(target)(['sh', '-c', `set -eu
${skillStateProgram}
root="$HOME/.local/share/dsh-remote/skills"
lock="$root/.deploy-lock"
mkdir "$lock"
trap 'rmdir "$lock"' EXIT HUP INT TERM
test "$(skill_state "$1")" = "$2" || { echo 'Skill changed since preview; preview again' >&2; exit 1; }
if [ "$2" != absent ]; then rm -- "$HOME/.agents/skills/$1"; fi
`, 'dsh-skill-remove', name, expected], { signal });
}

export interface SkillFileChange { path: string; action: 'add' | 'update' | 'remove'; directory: boolean }
export interface SkillFileChanges { items: SkillFileChange[]; counts: { add: number; update: number; remove: number }; truncated: boolean }

/** Compare manifests without creating remote files; cap the wire list, never the counts. */
export async function inspectSkillChanges(target: SshTarget, name: string, expected: string, desired: string, signal?: AbortSignal): Promise<SkillFileChanges> {
  const output = await sshControl(target)(['sh', '-c', `set -eu
${skillStateProgram}
test "$(skill_state "$1")" = "$2" || exit 1
desired=$(cat)
current=''
if [ "$2" != absent ]; then
  revision=\${2%%:*}
  current=$(skill_manifest "$HOME/.local/share/dsh-remote/skills/$1/$revision")
  fingerprint=$(printf '%s\\n' "$current" | skill_sha)
  test "\${fingerprint%% *}" = "\${2#*:}" || exit 1
fi
printf '%s\\n--current--\\n%s\\n' "$desired" "$current" | awk '
  $0 == "--current--" { actual = 1; next }
  $1 == "d" || $1 == "f" {
    key = $1 == "d" ? $2 : $4
    if (key == "") next
    if (actual) old[key] = $0; else wanted[key] = $0
  }
  function emit(action, key, record, parts, line) {
    counts[action]++
    split(record, parts, " ")
    line = action " " parts[1] " " key "\\n"
    if (bytes + length(line) <= 48000) { printf "%s", line; bytes += length(line) }
  }
  END {
    for (key in wanted) {
      if (!(key in old)) emit("add", key, wanted[key])
      else if (wanted[key] != old[key]) emit("update", key, wanted[key])
    }
    for (key in old) if (!(key in wanted)) emit("remove", key, old[key])
    printf "counts %d %d %d\\n", counts["add"], counts["update"], counts["remove"]
  }
'
`, 'dsh-skill-diff', name, expected], { signal, input: Readable.from([desired]) });
  const lines = output.trimEnd().split('\n');
  const count = /^counts (\d+) (\d+) (\d+)$/.exec(lines.pop() ?? '');
  if (!count) throw new Error('Invalid remote skill diff');
  const counts = { add: Number(count[1]), update: Number(count[2]), remove: Number(count[3]) };
  const items = lines.filter(Boolean).map(line => {
    const entry = /^(add|update|remove) ([df]) ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!entry) throw new Error('Invalid remote skill diff entry');
    return { action: entry[1] as SkillFileChange['action'], directory: entry[2] === 'd', path: Buffer.from(entry[3], 'base64').toString('utf8') };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { items, counts, truncated: items.length < counts.add + counts.update + counts.remove };
}
