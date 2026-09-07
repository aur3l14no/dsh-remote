// Copied to the isolated upstream checkout. External plugin bundles must share
// the same DSH source identities as upstream's scaffold (including scope symbols).
import ts from 'typescript';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from './vitest.web.config.ts';
const paths = ts.readConfigFile('./tsconfig.base.json', ts.sys.readFile).config.compilerOptions.paths;
const alias = Object.entries(paths).filter(([name]) => !name.includes('*')).map(([name, values]) => {
  const candidate = resolve((values as string[])[0]!);
  let replacement = candidate;
  try { if (statSync(candidate).isDirectory()) replacement = join(candidate, 'index.ts'); } catch {}
  return { find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement };
});
export default mergeConfig(base, { resolve: { alias }, test: { server: { deps: { inline: [/web-plugin/] } } } });
