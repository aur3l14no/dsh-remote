/** Host connection and maintenance operation; never called by model tools. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { skillStateProgram } from './state.ts';
import { sshControl } from '../../../../../../runtime/ssh/src/control.ts';
import type { SshTarget } from '../../../../../../runtime/ssh/src/transport.ts';

export interface SkillInstall { name: string; source: string; requires?: string[] }
export interface SkillDeployment { target: SshTarget; skills: SkillInstall[] }

// Arguments are transported as argv by sshControl. This fixed control program is
// deployment plumbing, not a model command rewritten to run on another host.
const install = `set -eu
name=$1
revision=$2
expected=\${3:-*}
${skillStateProgram}
case "$HOME" in /*) ;; *) echo 'Absolute remote HOME required' >&2; exit 1;; esac
root="$HOME/.local/share/dsh-remote/skills"
links="$HOME/.agents/skills"
mkdir -p "$root" "$links"
lock="$root/.deploy-lock"
if ! mkdir "$lock"; then echo 'Another skill deployment owns the lock' >&2; exit 1; fi
stage=''
trap 'if [ -n "$stage" ]; then rm -rf "$stage"; fi; rmdir "$lock"' EXIT HUP INT TERM
if [ "$expected" != '*' ] && [ "$(skill_state "$name")" != "$expected" ]; then
  echo 'Skill changed since preview; preview again' >&2; exit 1
fi
stage=$(mktemp -d "$root/.stage.XXXXXXXX")
link="$links/$name"
if [ -e "$link" ] || [ -L "$link" ]; then
  if [ ! -L "$link" ]; then echo 'Skill destination is not a managed symlink' >&2; exit 1; fi
  old=$(readlink "$link")
  case "$old" in "$root/$name/"*) ;; *) echo 'Skill destination belongs to another manager' >&2; exit 1;; esac
fi
tar -xpf - -C "$stage"
test -f "$stage/SKILL.md"
mkdir -p "$root/$name"
destination="$root/$name/$revision"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  test ! -L "$destination" && test -d "$destination"
  diff -qr "$stage" "$destination" >/dev/null
  find "$stage" -type f -exec sh -c '
    stage=$1; destination=$2; shift 2
    for file do
      other="$destination/\${file#"$stage/"}"
      test ! -L "$other" && test "$(stat -c %a "$file")" = "$(stat -c %a "$other")" || exit 1
    done
  ' sh "$stage" "$destination" {} +
else
  mv "$stage" "$destination"
  stage=$(mktemp -d "$root/.stage.XXXXXXXX")
fi
ln -s "$destination" "$stage/link"
mv -Tf "$stage/link" "$link"
printf '%s\\n' "$destination"
`;

/** Materialize selected sources first, so invalid input cannot partially deploy. */
export async function prepareSkills(skills: SkillInstall[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const staging = await mkdtemp(join(tmpdir(), 'dsh-skills-'));
  try {
    const seen = new Set<string>();
    const selected = [];
    for (const skill of skills) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || seen.has(skill.name)) throw new Error('Invalid or duplicate skill deployment name');
      seen.add(skill.name);
      const source = await realpath(resolve(skill.source));
      const directory = join(staging, skill.name);
      await mkdir(directory);
      const files: string[] = [];
      const manifest: string[] = [];
      let bytes = 0;
      let entries = 0;
      const hash = createHash('sha256');
      async function walk(relative: string): Promise<void> {
        signal?.throwIfAborted();
        if (++entries > 8192 || relative.split('/').length > 64) throw new Error('Skill directory tree exceeds deployment limits');
        const info = await lstat(join(source, relative));
        if (info.isDirectory()) {
          await mkdir(join(directory, relative), { recursive: true });
          hash.update(JSON.stringify(['directory', relative]));
          manifest.push(`d ${Buffer.from(relative).toString('base64')}`);
          for (const entry of (await readdir(join(source, relative))).sort()) await walk(join(relative, entry));
        } else if (info.isFile()) {
          bytes += info.size;
          if (bytes > 32 * 1024 * 1024 || files.length >= 4096) throw new Error('Skill bundle exceeds deployment limits');
          const content = await readFile(join(source, relative));
          hash.update(JSON.stringify([relative, info.mode & 0o777, content.length])).update(content);
          await mkdir(join(directory, relative, '..'), { recursive: true });
          await writeFile(join(directory, relative), content);
          await chmod(join(directory, relative), info.mode & 0o777);
          files.push(relative);
          manifest.push(`f ${(info.mode & 0o777).toString(8)} ${createHash('sha256').update(content).digest('hex')} ${Buffer.from(relative).toString('base64')}`);
        } else throw new Error('Skill bundle contains a symlink or special file; use a self-contained source');
      }
      await walk('');
      if (!files.includes('SKILL.md')) throw new Error('Selected skill has no SKILL.md');
      const requires = skill.requires ?? [];
      if (!requires.every(command => /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(command))) throw new Error('Prerequisites must be executable names');
      const manifestText = manifest.sort().join('\n') + '\n';
      selected.push({ name: skill.name, revision: hash.digest('hex'), directory, requires, files, manifest: manifestText, contentDigest: createHash('sha256').update(manifestText).digest('hex') });
    }
    return { selected, dispose: () => rm(staging, { recursive: true, force: true }) };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export type PreparedSkills = Awaited<ReturnType<typeof prepareSkills>>;

export async function deployPrepared(target: SshTarget, prepared: PreparedSkills, signal?: AbortSignal, expected?: Map<string, string>) {
  const selected = prepared.selected;
  const control = sshControl(target);
  for (const command of new Set(selected.flatMap(skill => skill.requires))) {
    try { await control(['sh', '-c', 'command -v "$1" >/dev/null', 'dsh-skill-prerequisite', command], { signal }); }
    catch (cause) { throw new Error(`Remote skill prerequisite unavailable: ${command}`, { cause }); }
  }
  const results = [];
  for (const skill of selected) {
    const archive = execFileSync('tar', ['-cf', '-', '-C', skill.directory, '.'], { maxBuffer: 40 * 1024 * 1024 });
    const path = (await control(['sh', '-c', install, 'dsh-skill-deploy', skill.name, skill.revision, expected?.get(skill.name) ?? '*'], {
      input: Readable.from([archive]), timeoutMs: 120000, signal,
    })).trim();
    if (!path.startsWith('/') || path.includes('\n')) throw new Error('Invalid remote skill installation path');
    results.push({ name: skill.name, revision: skill.revision, path });
  }
  return results;
}

export async function deploySkills(config: SkillDeployment, signal?: AbortSignal) {
  const prepared = await prepareSkills(config.skills, signal);
  try { return await deployPrepared(config.target, prepared, signal); }
  finally { await prepared.dispose(); }
}
