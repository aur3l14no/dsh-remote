import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Rebuild a patched browser plugin, retaining the official module-table identity. */
export async function buildClientCompatibility(source, installation, metadata, destination) {
  const { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } = await import(pathToFileURL(join(source, 'packages/client/web/src/platform.ts')));
  const external = [...PLATFORM_MODULES, ...PRELOADED_CLIENT_EXTERNALS, ...(metadata.dsh.client.external ?? [])];
  const result = await build({
    entryPoints: [join(source, metadata.repository.directory, 'src/client/index.ts')],
    outfile: join(destination, 'lib/client.js'), bundle: true, write: false, metafile: true,
    format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
    nodePaths: [join(installation, 'node_modules')], external,
    loader: { '.module.css': 'local-css' },
  });
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const script = result.outputFiles.find(file => file.path.endsWith('.js'));
  if (!script || result.outputFiles.some(file => !/\.(css|js)$/.test(file.path))) throw new Error('Unsupported client build output');
  const styles = css ? `const style = document.createElement('style'); style.dataset.plugin = ${JSON.stringify(metadata.name)}; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style);` : '';
  await writeFile(join(destination, 'lib/client.js'), `window.__ModuleLoader__.load({ id: ${JSON.stringify(metadata.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; ${styles}\n${script.text}\nreturn module.exports; } });\n`);
}
