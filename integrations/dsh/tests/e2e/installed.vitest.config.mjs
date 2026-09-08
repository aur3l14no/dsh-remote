import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
const installedRequire = createRequire(process.env.DSH_TEST_INSTALL + '/package.json');
export default defineConfig({
  plugins: [{ name: 'installed-dsh-test-imports', enforce: 'pre', resolveId(name) {
    if (name.startsWith('@deepseek-ai/')) return { id: installedRequire.resolve(name), external: true };
  } }],
  test: {
    pool: 'forks', execArgv: ['--expose-internals'],
    server: { deps: { inline: [/browser-fixtures/], external: [/official-install\/node_modules/] } },
    include: ['apps/web/tests/*.e2e.ts'], testTimeout: 240000, hookTimeout: 120000, fileParallelism: false,
  },
});
