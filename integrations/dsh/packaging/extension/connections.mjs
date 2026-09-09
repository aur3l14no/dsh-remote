import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const validHost = host => typeof host === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.@:[\]-]{0,254}$/.test(host);

/** Connect reuses OpenSSH's keys, agent and known_hosts; it never enrolls keys or asks for credentials. */
export function createConnections(load, save, control) {
  const opening = new Map();
  const lifecycle = new AbortController();
  let saving = Promise.resolve();
  return {
    async hosts() {
      let source = '';
      try { source = await readFile(join(homedir(), '.ssh/config'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return [...new Set(source.split('\n').filter(line => /^\s*Host\s+/i.test(line)).flatMap(line => line.trim().split(/\s+/).slice(1)).filter(validHost))];
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
        } catch { throw new Error(`Could not connect to ${host}. First run ssh ${host} in your terminal and verify public-key login and known_hosts, then retry Connect.`); }
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
