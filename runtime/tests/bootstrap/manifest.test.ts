import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseManifest, selectBundle, cacheArtifact, sshArguments } from '../../ssh/src/index.ts';
import { execute } from '../../ssh/src/control.ts';

test('trusted manifest rejects invalid metadata and ambiguous or incompatible ABI selection', () => {
  const artifact = { bytes: 100, sha256: 'a'.repeat(64) };
  const bundle = { target: { os: 'linux', arch: 'x86_64', abi: { kind: 'glibc', minimum: '2.39' } }, helper: { version: '0.1.1', api: 1, artifact }, ripgrep: { version: '15.2.0', artifact } };
  const manifest = parseManifest({ format: 1, bundles: [bundle] });
  assert.equal(selectBundle(manifest, { os: 'linux', arch: 'x86_64', glibc: '2.40' }).helper.version, '0.1.1');
  for (const glibc of [undefined, '2.38']) assert.throws(() => selectBundle(manifest, { os: 'linux', arch: 'x86_64', glibc }), { code: 'UNSUPPORTED_PLATFORM' });
  assert.throws(() => parseManifest({ format: 1, bundles: [{ ...bundle, helper: { ...bundle.helper, api: 2 } }] }), { code: 'INVALID_MANIFEST' });
  assert.throws(() => parseManifest({ format: 1, bundles: [{ ...bundle, ripgrep: { ...bundle.ripgrep, artifact: { bytes: Infinity, sha256: 'x' } } }] }), { code: 'INVALID_MANIFEST' });
  const ambiguous = parseManifest({ format: 1, bundles: [bundle, { ...bundle, target: { ...bundle.target, abi: { kind: 'musl-static' } } }] });
  assert.throws(() => selectBundle(ambiguous, { os: 'linux', arch: 'x86_64', glibc: '2.39' }), { code: 'UNSUPPORTED_PLATFORM' });
});

test('local cache verifies bytes before atomic publication and never publishes a mismatch', async () => {
  const dir = await mkdtemp('/tmp/dsh-cache-test.');
  try {
    await writeFile(`${dir}/source`, 'binary\0fixture');
    const artifact = await cacheArtifact(`${dir}/source`, `${dir}/cache`);
    assert.equal((await readFile(`${dir}/cache/${artifact.sha256}`)).toString(), 'binary\0fixture');
    await writeFile(`${dir}/source`, 'changed\0fixture');
    await assert.rejects(cacheArtifact(`${dir}/source`, `${dir}/cache`, artifact), { code: 'ARTIFACT_MISMATCH' });
    assert.equal((await readFile(`${dir}/cache/${artifact.sha256}`)).toString(), 'binary\0fixture');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenSSH control quoting preserves literal metacharacters without shell substitution', async () => {
  const value = "space 'quote' ; $(printf substituted) `printf substituted` \\ tail";
  const args = sshArguments({ host: 'example.invalid', configFile: '/tmp/config with spaces' }, ['printf', '%s', value]);
  assert.equal(await execute('sh', ['-c', args.at(-1)!]), value);
  assert.throws(() => sshArguments({ host: '-option' }, ['true']));
});

test('Podman entry preserves quoted argv and requests no transport PTY', async () => {
  const container = 'a'.repeat(64);
  const value = "space 'quote' ; $(printf substituted) `printf substituted` \\ tail";
  const args = sshArguments({ host: 'example.invalid', podmanContainer: container }, ['printf', '%s', value]);
  // A shell function observes the actual argv after OpenSSH's login-shell parsing.
  const observed = await execute('sh', ['-c', `podman() { printf '%s\\n' "$@"; }; ${args.at(-1)}`]);
  assert.equal(observed, ['exec', '-i', container, 'printf', '%s', value, ''].join('\n'));
  for (const invalid of ['', 'reusable-name', 'abc123', '-option', 'a'.repeat(64) + '\n']) {
    assert.throws(() => sshArguments({ host: 'example.invalid', podmanContainer: invalid }, ['true']), { code: 'INVALID_ARGUMENT' });
  }
});

test('control transport bounds output and honours cancellation and deadlines', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))']), { code: 'CONTROL_OUTPUT_LIMIT' });
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 }), { code: 'CONTROL_TIMEOUT' });
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: AbortSignal.timeout(30) }), { code: 'CANCELLED' });
});

test('control termination escalates when the transport ignores SIGTERM', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/dsh-control-test.');
  try {
    for (const reason of ['timeout', 'abort', 'output'] as const) {
      const pidFile = `${directory}/${reason}.pid`;
      const started = Date.now();
      const controller = new AbortController();
      const program = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));${reason === 'output' ? 'process.stdout.write("x".repeat(100000));' : ''}setInterval(()=>{},1000);`;
      const operation = execute(process.execPath, ['-e', program, pidFile], { timeoutMs: 1000, signal: controller.signal });
      const rejection = assert.rejects(operation, { code: reason === 'timeout' ? 'CONTROL_TIMEOUT' : reason === 'abort' ? 'CANCELLED' : 'CONTROL_OUTPUT_LIMIT' });
      let pid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      assert.ok(pid, 'transport installed its signal handler');
      if (reason === 'abort') controller.abort();
      const watchdog = setTimeout(() => { try { process.kill(pid!, 'SIGKILL'); } catch {} }, 3000);
      try { await rejection; assert.ok(Date.now() - started < 2500, 'termination must not wait for the watchdog'); }
      finally {
        clearTimeout(watchdog);
        // This also bounds leaked fixtures if the regression returns.
        try { process.kill(pid, 'SIGKILL'); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
