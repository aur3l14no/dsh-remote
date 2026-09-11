import * as NativeWorkspaces from '../../../workspace/local-workspace/src/native.ts';
import * as FilePreview from '../../../workspace/portable-workspace/src/file-preview.ts';
import type { Context } from '@deepseek-ai/cordis';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import ExecutionWorlds, { type Config as ExecutionConfig } from '../../../world/execution-world/src/worlds.ts';
import Registry, { type Config as RegistryConfig } from '../../../workspace/portable-workspace/src/registry.ts';
import { PortableWorkspaceApi, PortableWorkspaceFeed } from '../../../workspace/portable-workspace/src/api.ts';
import AccountPolicy from '../../../world/ssh-world/src/account-policy.ts';
import RemoteFileReferences from '../../../workspace/portable-workspace/src/file-references.ts';
import * as RemoteSkills from '../../../skill/remote-skills/src/index.ts';
import * as Admission from '../../../workspace/portable-workspace/src/admission.ts';
import { WorldsReload } from '../../../workspace/portable-workspace/src/reload.ts';
import { SkillSynchronizer } from '../../../skill/remote-skills/src/sync.ts';

export interface Config extends RegistryConfig {
  bindingFile: string;
  worldsFile?: string;
  bootstrap: ExecutionConfig['bootstrap'];
}
export const inject = ['storageDomain', 'sessionPersistence', 'sessions', 'agents', 'typert'];
export async function apply(ctx: Context, config: Config) {
  const sync = new SkillSynchronizer(config.worlds);
  ctx.effect(() => () => sync.dispose());
  await ctx.plugin(ExecutionWorlds, { local: ctx, bindingFile: config.bindingFile, bootstrap: config.bootstrap,
    packagedRipgrep: await SearchTools.resolveRgPath(), beforeConnect: definition => sync.beforeConnect(definition) });
  // A separate active fiber makes the feed visible before the registry releases
  // the controller. Services on this still-applying parent are not visible yet.
  await ctx.plugin(function workspaceFeed(ctx: Context) {
    ctx.provide('workspaceFeed', new PortableWorkspaceFeed(ctx));
  });
  await ctx.plugin(NativeWorkspaces);
  await ctx.plugin(Registry, { worlds: config.worlds });
  await ctx.plugin({ inject: ['worldPortableWorkspaces'], apply(ctx: Context) {
    if (config.worldsFile) {
      const reload = new WorldsReload(ctx, config.worldsFile, config.worlds, sync);
      ctx.provide('worldsReload', reload);
      ctx.effect(() => () => reload.dispose());
    }
    sync.selection = id => ctx.worldPortableWorkspaces.enabledSkills(id);
    ctx.effect(() => () => { sync.selection = undefined; });
  } });
  await ctx.plugin(Admission);
  await ctx.plugin(PortableWorkspaceApi);
  await ctx.plugin(AccountPolicy);
  await ctx.plugin(RemoteSkills);
  await ctx.plugin(RemoteFileReferences);
  await ctx.plugin(FilePreview);
}
