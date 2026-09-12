import { sameWorkspace } from '../../../world/execution-world/src/identity.ts';
/** Session-bound native and SSH skill discovery share DSH parsing and invocation controls. */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import type { SkillLookupOptions, SkillProviderControl } from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-agent-instructions';
import { observe } from '../../../../shared/lifetime.ts';
import { homedir } from 'node:os';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { posix } from 'node:path';
import { sshControl } from '../../../../../../runtime/ssh/src/control.ts';
import type {} from '../../../workspace/portable-workspace/src/registry.ts';
import type {} from '../../../world/execution-world/src/worlds.ts';

export const inject = ['skills', 'executionWorlds', 'worldPortableWorkspaces'];
export function apply(ctx: Context): void {
  const lifecycle = new AbortController();
  ctx.effect(() => () => lifecycle.abort(new Error('Remote context disposed')));
  const homes = new Map<string, Promise<string>>();
  async function environment(options: SkillLookupOptions) {
    if (!options.sessionId) throw new Error('Remote context requires a Session identity');
    const signal = options.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
    signal.throwIfAborted();
    const id = SessionId(options.sessionId);
    const workspace = await observe(ctx.worldPortableWorkspaces.contextForSession(id), signal);
    const expected = ctx.worldPortableWorkspaces.definition(workspace.id);
    const saved = ctx.executionWorlds.bindings.get(id);
    if (!saved || !sameWorkspace(expected, saved) || options.cwd !== expected.cwd) throw new Error('Remote context binding mismatch');
    const definition = await observe(ctx.executionWorlds.prepare(id), signal);
    const owner = await observe(ctx.executionWorlds.prepareWorkspace(definition), signal);
    if (definition.kind === 'local') return { owner, home: homedir(), cwd: definition.cwd, id: definition.id, signal, kind: 'local' as const };
    let home = homes.get(definition.id);
    if (!home) {
      home = sshControl(definition)(['sh', '-c', 'printf "%s" "$HOME"'], { signal: lifecycle.signal }).then(value => {
        if (!value.startsWith('/') || /[\r\n]/.test(value)) throw new Error('Remote home is not an absolute path');
        return value;
      });
      homes.set(definition.id, home);
      void home.catch(() => homes.delete(definition.id));
    }
    const remoteHome = await observe(home, signal);
    signal.throwIfAborted();
    return { owner, home: remoteHome, cwd: definition.cwd, id: definition.id, signal, kind: 'ssh' as const };
  }
  ctx.provide('agentInstructionEnvironment', { async resolve(agent, signal) {
    ctx.executionWorlds.forAgent(agent);
    const { owner, home, kind } = await environment({ sessionId: agent.session.header.id, cwd: agent.session.header.cwd, signal });
    return { fs: owner.fs, dshHome: kind === 'local' ? resolveDshHome() : posix.join(home, '.dsh') };
  } });
  for (const providerKind of ['local', 'ssh'] as const) ctx.skills.registerProvider((control: SkillProviderControl) => {
    const sources = new Map<string, FileSystemSkillProvider>();
    ctx.effect(() => async () => {
      await Promise.all([...sources.values()].map(source => source.dispose()));
    });
    async function provider(options: SkillLookupOptions) {
      const { owner, home, cwd, id, signal, kind } = await environment(options);
      if (kind !== providerKind) return undefined;
      if (kind === 'local') {
        let source = sources.get('local');
        if (!source) {
          source = new FileSystemSkillProvider(owner, control, {});
          sources.set('local', source);
        }
        return { source, signal };
      }
      let root = cwd;
      while (true) {
        const git = await owner.fs.resolve(posix.join(root, '.git'), { signal });
        if (await owner.fs.stat(git, signal)) break;
        const parent = posix.dirname(root);
        if (parent === root) { root = cwd; break; }
        root = parent;
      }
      signal.throwIfAborted();
      const key = JSON.stringify([id, root]);
      let pending = sources.get(key);
      if (!pending) {
        // Explicit roots exclude all host homes, bundled roots and chokidar.
        pending = new FileSystemSkillProvider(owner, control, {
          providerName: 'remote-filesystem', watch: false, includeDefaultRoots: false,
          customSkillDirs: [posix.join(root, '.dsh/skills'), posix.join(root, '.agents/skills'), posix.join(home, '.agents/skills')],
        });
        sources.set(key, pending);
      }
      return { source: pending, signal };
    }
    return { name: providerKind === 'local' ? 'filesystem' : 'remote-filesystem',
      async list(options) {
        const selected = await provider(options);
        if (!selected) return [];
        const { source, signal } = selected;
        // The host registry disables catalog caching because no remote watcher is mounted.
        return await source.list({ ...options, signal });
      },
      async get(candidate, options) {
        const selected = await provider(options);
        if (!selected) return undefined;
        const { source, signal } = selected;
        return await source.get(candidate, { ...options, signal });
      },
    };
  });
}
