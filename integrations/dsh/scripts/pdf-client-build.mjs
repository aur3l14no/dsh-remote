import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Preserve the pinned upstream preview bundle's PDF worker, assets and license notices. */
export function pdfClientBuild(expectedVersion) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version !== expectedVersion) throw new Error('PDF.js build dependency must match the pinned upstream preview');
  const directories = [['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm']];
  const assets = Object.fromEntries(directories.map(([kind, directory]) => [kind, Object.fromEntries(
    readdirSync(join(root, directory)).filter(name => !name.startsWith('LICENSE')).sort()
      .map(name => [name, readFileSync(join(root, directory, name)).toString('base64')]),
  )]));
  const licenses = ['LICENSE', ...directories.flatMap(([, directory]) => readdirSync(join(root, directory))
    .filter(name => name.startsWith('LICENSE')).sort().map(name => `${directory}/${name}`))];
  return {
    define: { __DSH_PDFJS_ASSETS__: JSON.stringify(assets) },
    banner: { js: ['//! Bundled PDF.js license notices', ...licenses.flatMap(name =>
      `${name}\n\n${readFileSync(join(root, name), 'utf8').trimEnd()}`.split('\n').map(line => `// ${line}`))].join('\n') },
    plugins: [{ name: 'pdf-worker', setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({ path: require.resolve(args.path.slice(0, -4)), namespace: 'raw-source' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw-source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
    } }],
  };
}
