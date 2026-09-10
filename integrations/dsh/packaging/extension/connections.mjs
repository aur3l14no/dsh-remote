import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const validHost = host => typeof host === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.@:[\]-]{0,254}$/.test(host);
const execute = promisify(execFile);

/** Connect reuses OpenSSH's keys, agent and known_hosts; it never enrolls keys or asks for credentials. */
export function createConnections(load, save, control) {
  const opening = new Map();
  const lifecycle = new AbortController();
  let saving = Promise.resolve();
  return {
    async hosts() {
      // OpenSSH expands Include itself, including nested globs and system config.
      // -G does not connect; debug output supplies paths, not resolved host aliases.
      const { stderr } = await execute('ssh', ['-G', '-vv', '--', 'dsh-host-discovery.invalid'], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, signal: lifecycle.signal,
        env: { ...process.env, LC_ALL: 'C' },
      });
      const files = [...new Set([...stderr.matchAll(/^debug1: Reading configuration data (.+)\r?$/gm)].map(match => match[1].trimEnd()))];
      const hosts = new Set();
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const line of source.split('\n')) {
          const declaration = /^\s*Host(?:\s*=\s*|\s+)(.*)$/i.exec(line);
          if (!declaration) continue;
          for (const token of declaration[1].matchAll(/"([^"]*)"|([^\s"]+)/g)) {
            const host = token[1] ?? token[2];
            if (host.startsWith('#')) break;
            if (validHost(host)) hosts.add(host);
          }
        }
      }
      return [...hosts];
    },
    connect(host) {
      if (!validHost(host)) throw new Error('Enter an SSH alias or user@host');
      if (opening.has(host)) return opening.get(host);
      const pending = (async () => {
        let home;
        try {
          const stdout = await control({ host })(['sh', '-c', 'printf "%s\\n" "$HOME"'], { signal: lifecycle.signal, timeoutMs: 15000 });
          home = stdout.trim();
          if (!home.startsWith('/') || /[\0\r\n]/.test(home)) throw new Error('Invalid remote home');
        } catch { throw new Error(`Could not connect to ${host}. First run ssh ${host} in your terminal and verify noninteractive login and SSH configuration, then retry Connect.`); }
        const id = 'ssh-' + createHash('sha256').update(host).digest('hex').slice(0, 24);
        let world;
        const commit = saving.catch(() => {}).then(async () => {
          const config = load();
          world = config.worlds.find(item => item.id === id) ?? { id, name: host, target: { kind: 'ssh', host } };
          if (world.target.host !== host) throw new Error('Saved SSH target changed');
          if (!config.worlds.some(item => item.id === id)) { config.worlds.push(world); await save(config); }
        });
        saving = commit;
        await commit;
        return { world, home };
      })().finally(() => opening.delete(host));
      opening.set(host, pending);
      return pending;
    },
    async dispose() {
      lifecycle.abort();
      await Promise.allSettled([...opening.values()]);
    },
  };
}
