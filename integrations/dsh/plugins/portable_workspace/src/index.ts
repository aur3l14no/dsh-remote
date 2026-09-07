import type { Context } from '@deepseek-ai/cordis';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import ExecutionWorlds, { type Config as ExecutionConfig } from '../../ssh-world/src/worlds.ts';
import Registry, { type Config as RegistryConfig } from './registry.ts';
import { PortableWorkspaceApi, PortableWorkspaceFeed } from './api.ts';
import * as Admission from '../../session-admission/src/index.ts';

export interface Config extends RegistryConfig {
  bindingFile: string;
  bootstrap: ExecutionConfig['bootstrap'];
}
export const inject = ['storageDomain', 'sessionPersistence', 'sessions', 'agents', 'typert'];
export async function apply(ctx: Context, config: Config) {
  await ctx.plugin(ExecutionWorlds, { bindingFile: config.bindingFile, bootstrap: config.bootstrap, packagedRipgrep: await SearchTools.resolveRgPath() });
  // A separate active fiber makes the feed visible before the registry releases
  // the controller. Services on this still-applying parent are not visible yet.
  await ctx.plugin(function workspaceFeed(ctx: Context) {
    ctx.provide('workspaceFeed', new PortableWorkspaceFeed(ctx));
  });
  await ctx.plugin(Registry, { worlds: config.worlds });
  await ctx.plugin(Admission);
  await ctx.plugin(PortableWorkspaceApi);
}
