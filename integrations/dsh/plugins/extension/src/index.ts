import * as FilePreview from '../../file-preview/src/index.ts';
import type { Context } from '@deepseek-ai/cordis';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import ExecutionWorlds, { type Config as ExecutionConfig } from '../../ssh-world/src/worlds.ts';
import Registry, { type Config as RegistryConfig } from '../../portable_workspace/src/registry.ts';
import { PortableWorkspaceApi, PortableWorkspaceFeed } from '../../portable_workspace/src/api.ts';
import AccountPolicy from '../../account-policy/src/index.ts';
import RemoteFileReferences from '../../file-references/src/index.ts';
import * as RemoteSkills from '../../skills/src/index.ts';
import * as Admission from '../../session-admission/src/index.ts';
import { SkillSynchronizer } from '../../skills/src/sync.ts';

export interface Config extends RegistryConfig {
  bindingFile: string;
  bootstrap: ExecutionConfig['bootstrap'];
}
export const inject = ['storageDomain', 'sessionPersistence', 'sessions', 'agents', 'typert'];
export async function apply(ctx: Context, config: Config) {
  const sync = new SkillSynchronizer(config.worlds);
  ctx.effect(() => () => sync.dispose());
  await ctx.plugin(function skillSyncService(ctx: Context) { ctx.provide('worldSkillSync', sync); });
  await ctx.plugin(ExecutionWorlds, { bindingFile: config.bindingFile, bootstrap: config.bootstrap,
    packagedRipgrep: await SearchTools.resolveRgPath(), beforeConnect: definition => sync.beforeConnect(definition) });
  // A separate active fiber makes the feed visible before the registry releases
  // the controller. Services on this still-applying parent are not visible yet.
  await ctx.plugin(function workspaceFeed(ctx: Context) {
    ctx.provide('workspaceFeed', new PortableWorkspaceFeed(ctx));
  });
  await ctx.plugin(Registry, { worlds: config.worlds });
  await ctx.plugin(Admission);
  await ctx.plugin(PortableWorkspaceApi);
  await ctx.plugin(AccountPolicy);
  await ctx.plugin(RemoteSkills);
  await ctx.plugin(RemoteFileReferences);
  await ctx.plugin(FilePreview);
}
