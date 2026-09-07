import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { Client, RemoteProcess, writeFile } from '../../client/src/index.ts';
import { bootstrapSshWorld, cacheArtifact, connectSuppliedRuntime, parseManifest, bundleKey } from '../../ssh/src/index.ts';
import { provisionWorld } from '../../ssh/src/bootstrap.ts';
import type { BootstrapOptions, SshWorld } from '../../ssh/src/bootstrap.ts';
import { execute, sshControl } from '../../ssh/src/control.ts';
import type { Control } from '../../ssh/src/control.ts';
import { probe, install } from '../../ssh/src/provision.ts';
import type { Bundle } from '../../ssh/src/manifest.ts';

const host = process.env.DSH_TEST_HOST;
const enabled = !!host || process.env.DSH_TEST_NATIVE_BOOTSTRAP === '1';

test('bootstrap acceptance: supplied local cache to selected platform', { skip: !enabled, timeout: 600000 }, async t => {
  const target = { host: host ?? 'native-acceptance', configFile: process.env.DSH_TEST_SSH_CONFIG,
    podmanContainer: process.env.DSH_TEST_PODMAN_CONTAINER };
  const control: Control = host ? sshControl(target) : (argv, options) => execute(argv[0]!, argv.slice(1), options);
  const root = (await control(['mktemp', '-d', '/tmp/dsh-bootstrap-test.XXXXXXXX'])).trim();
  assert.match(root, /^\/tmp\/dsh-bootstrap-test\.[A-Za-z0-9]{8}$/);
  const cache = await mkdtemp('/tmp/dsh-bootstrap-cache.');
  const worlds = new Set<SshWorld>();
  const connect: Parameters<typeof provisionWorld>[1] = host ? args => connectSuppliedRuntime({ ...target, ...args }) : args => Client.open({ world: args.world, required: args.required, connectTimeoutMs: args.connectTimeoutMs, connect: async () => createConnection(args.socket) });
  const cwd = `${root}/workspace 'quote'`;
  try {
    await control(['mkdir', cwd]);
    const platform = await probe(control, cwd);
    const helperPath = process.env.DSH_BOOTSTRAP_HELPER ?? resolve('target/debug/dsh-remote');
    const rgPath = process.env.DSH_BOOTSTRAP_RG;
    const fixture = host ? process.env.DSH_TEST_REMOTE_FIXTURE : resolve('target/debug/dsh-remote-fixture');
    assert.ok(rgPath, 'Supply the selected target-native ripgrep file in the local cache');
    assert.ok(fixture, 'Supply the target-native acceptance process fixture');
    const bundle = parseManifest({ format: 1, bundles: [{
      target: { os: platform.os, arch: platform.arch, abi: platform.os === 'macos' ? { kind: 'darwin' } : platform.glibc ? { kind: 'glibc', minimum: platform.glibc } : { kind: 'musl-static' } },
      helper: { version: '0.1.1', api: 1, artifact: await cacheArtifact(resolve(helperPath), cache) },
      ripgrep: { version: '15.2.0', artifact: await cacheArtifact(resolve(rgPath), cache) },
    }] }).bundles[0]!;
    const options: BootstrapOptions = { ...target, world: 'bootstrap-test', cwd, cacheDir: cache, manifest: { format: 1, bundles: [bundle] }, installRoot: `${root}/install space'quote`, runtimeBase: root, graceMs: 15000, leaseMs: 5000 };
    const start = async (overrides: Partial<BootstrapOptions> = {}) => {
      const world = host ? await bootstrapSshWorld({ ...options, ...overrides }) : await provisionWorld(control, connect, { ...options, ...overrides });
      worlds.add(world); return world;
    };
    let first!: SshWorld;
    await t.test('cold installation, negotiated helper and remote managed search', async () => {
      first = await start(); assert.equal(first.installation.reused, false);
      assert.equal(first.client.info.cwd, platform.cwd);
      await writeFile(first.client, `${cwd}/sentinel.txt`, Buffer.from('needle remotely\n'));
      if (host) await assert.rejects(readFile(`${cwd}/sentinel.txt`), { code: 'ENOENT' });
      const p = await RemoteProcess.spawn(first.client, { argv: [first.ripgrep, '--no-config', 'needle', 'sentinel.txt'], cwd, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
      assert.equal((await p.done).rootExit?.code, 0);
      assert.equal(p.collected[0]!.readFrom(0).text, 'needle remotely\n'); await p.release();
    });
    assert.ok(first, 'Cold bootstrap must succeed before dependent acceptance checks');
    await t.test('reuse verifies remote bytes and works without local artifacts', async () => {
      const second = await start({ cacheDir: `${cache}/absent`, world: 'reuse' });
      assert.equal(second.installation.reused, true); assert.equal(second.installation.helper, first.installation.helper);
      await second.close();
    });
    await t.test('corruption repair keeps the existing runtime and reconnect path', async () => {
      const held = await RemoteProcess.spawn(first.client, { argv: [fixture, 'hold'], cwd, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
      await control(['sh', '-c', 'dir=$(dirname "$1"); chmod 700 "$dir"; rm "$1"; printf broken > "$1"; chmod 500 "$1" "$dir"', 'fixture', first.ripgrep]);
      const repaired = await start({ world: 'repair' });
      assert.notEqual(repaired.installation.helper, first.installation.helper);
      first.client.reconnect(); await first.client.whenReady();
      assert.equal((await first.client.request<{ rootExit: unknown }>('process.status', { process: held.id })).rootExit, null);
      await held.terminate(); await held.release(); await repaired.close();
    });
    await t.test('concurrent cold installs publish one generation', async () => {
      const concurrent = { ...platform, installRoot: `${root}/concurrent` };
      const [a, b] = await Promise.all([install(control, concurrent, bundle, cache), install(control, concurrent, bundle, cache)]);
      assert.equal(a.helper, b.helper); assert.equal(Number(a.reused) + Number(b.reused), 1);
    });
    await t.test('interrupted upload remains unpublished and next install succeeds', async () => {
      let cut = false;
      const interrupted: Control = (argv, opt) => {
        if (!cut && opt?.input) {
          cut = true; opt.input.destroy();
          return control(argv, { ...opt, input: Readable.from([Buffer.from('partial')]) }).then(() => { throw new Error('injected transport loss after partial upload'); });
        }
        return control(argv, opt);
      };
      const destination = { ...platform, installRoot: `${root}/interrupted` };
      await assert.rejects(install(interrupted, destination, bundle, cache), /injected transport loss/);
      assert.equal((await control(['ls', '-A', `${destination.installRoot}/refs`])).trim(), '');
      assert.equal((await control(['ls', '-A', `${destination.installRoot}/generations`])).trim(), '');
      assert.equal((await install(control, destination, bundle, cache)).reused, false);
    });
    await t.test('lost publication response preserves committed generation for retry', async () => {
      let lost = false;
      const interrupted: Control = async (argv, opt) => {
        const result = await control(argv, opt);
        if (!lost && result.startsWith('INSTALLED ')) { lost = true; throw new Error('injected lost publication response'); }
        return result;
      };
      const destination = { ...platform, installRoot: `${root}/lost-publication` };
      await assert.rejects(install(interrupted, destination, bundle, cache), /lost publication/);
      assert.equal((await install(control, destination, bundle, `${cache}/absent`)).reused, true);
    });
    await t.test('bounded lock contention reports busy and does not steal the lock', async () => {
      const destination = { ...platform, installRoot: `${root}/locked` };
      await control(['mkdir', '-p', `${destination.installRoot}/locks/${bundleKey(bundle)}`]);
      await control(['chmod', '700', destination.installRoot, `${destination.installRoot}/locks`]);
      await assert.rejects(install(control, destination, bundle, cache, { lockWaitMs: 100 }), { code: 'INSTALL_BUSY' });
      await control(['rmdir', `${destination.installRoot}/locks/${bundleKey(bundle)}`]);
      assert.equal((await install(control, destination, bundle, cache)).reused, false);
    });
    await t.test('unusable default directory fails; explicit alternative succeeds', async () => {
      const home = `${root}/fixture-home`;
      await control(['mkdir', '-p', `${home}/.cache/dsh-remote`]);
      await control(['chmod', '500', `${home}/.cache/dsh-remote`]);
      const withHome: Control = (argv, opt) => control(['env', `HOME=${home}`, ...argv], opt);
      const defaults = await probe(withHome, cwd);
      assert.equal(defaults.installRoot, `${home}/.cache/dsh-remote`);
      await assert.rejects(install(withHome, defaults, bundle, cache), { code: 'UNSAFE_INSTALL_ROOT' });
      const alternate = await install(withHome, { ...defaults, installRoot: `${home}/alternative` }, bundle, cache);
      assert.equal(alternate.reused, false);
    });
    await t.test('incompatible build and required capability fail before publication', async () => {
      const wrong: Bundle = { ...bundle, helper: { ...bundle.helper, version: '99.0.0' } };
      await assert.rejects(start({ manifest: { format: 1, bundles: [wrong] }, installRoot: `${root}/wrong-build` }), { code: 'ARTIFACT_VERSION_MISMATCH' });
      const graceMs = host ? 10000 : 100;
      await assert.rejects(start({ required: ['nonexistent.capability'], graceMs }), { code: 'UNSUPPORTED' });
      await new Promise(resolve => setTimeout(resolve, graceMs + 100));
    });
    await t.test('distinct helper upgrade preserves old live runtime', { skip: !process.env.DSH_BOOTSTRAP_PREVIOUS_HELPER }, async () => {
      const previous = { ...bundle, helper: { version: '0.1.0', api: 1, artifact: await cacheArtifact(resolve(process.env.DSH_BOOTSTRAP_PREVIOUS_HELPER!), cache) } };
      const old = await start({ manifest: { format: 1, bundles: [previous] }, world: 'previous' });
      const held = await RemoteProcess.spawn(old.client, { argv: [fixture, 'hold'], cwd, stdout: { mode: 'collect', maxBytes: 1024 }, stderr: { mode: 'collect', maxBytes: 1024 } });
      const upgraded = await start({ world: 'upgraded' });
      assert.equal(old.client.info.build, '0.1.0'); assert.equal(upgraded.client.info.build, '0.1.1');
      assert.notEqual(old.installation.helper, upgraded.installation.helper);
      old.client.reconnect(); await old.client.whenReady();
      assert.equal((await old.client.request<{ rootExit: unknown }>('process.status', { process: held.id })).rootExit, null);
      await held.terminate(); await held.release(); await old.close(); await upgraded.close();
    });
    await first.close();
  } finally {
    const results = await Promise.allSettled([...worlds].map(world => world.close()));
    await control(['sh', '-c', 'chmod -R u+w "$1"; rm -rf "$1"', 'cleanup', root]);
    await rm(cache, { recursive: true, force: true });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
});
