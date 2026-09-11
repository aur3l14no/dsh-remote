import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { worldCommand } from '../../../world/execution-world/src/command.ts';
import type {} from '../../../world/execution-world/src/worlds.ts';
import type { MachineObservation } from './types.ts';

/** Fixed, bounded Linux probes. No model-supplied executable, path or network destination. */
export async function inspectMachine(ctx: Context, agent: Agent, signal: AbortSignal): Promise<MachineObservation> {
  const owner = ctx.executionWorlds.forAgent(agent);
  const definition = ctx.executionWorlds.bindings.get(agent.id)!;
  if (definition.kind !== 'ssh') throw new Error('Machine inspection requires a bound SSH World');
  const errors: MachineObservation['errors'] = [];
  const probe = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); }
    catch (error) { signal.throwIfAborted(); errors.push({ probe: name, message: String(error).slice(0, 1000) }); return null; }
  };
  const read = async (path: string) => owner.fs.readText(await owner.fs.resolve(path, { cwd: definition.cwd, signal }), signal);
  const command = (argv: string[]) => worldCommand(owner, definition.cwd, argv, signal);
  const [hostname, osRelease, arch, cpu, memory, uptime, addresses, routes, disks] = await Promise.all([
    probe('hostname', () => command(['uname', '-n'])),
    probe('os', () => read('/etc/os-release')),
    probe('architecture', () => command(['uname', '-m'])),
    probe('cpu', () => command(['nproc'])),
    probe('memory', () => read('/proc/meminfo')),
    probe('uptime', () => read('/proc/uptime')),
    probe('interfaces', async () => {
      const rows = JSON.parse(await command(['ip', '-j', 'address', 'show']));
      if (!Array.isArray(rows)) throw new Error('Invalid interface response');
      return rows.flatMap(row => (Array.isArray(row.addr_info) ? row.addr_info : []).map((addr: { local?: unknown; family?: unknown }) => ({
        interface: String(row.ifname ?? ''), address: String(addr.local ?? ''), family: String(addr.family ?? ''), state: String(row.operstate ?? 'unknown'),
      }))).slice(0, 128);
    }),
    probe('routes', async () => {
      const rows = JSON.parse(await command(['ip', '-j', 'route', 'show', 'default']));
      if (!Array.isArray(rows)) throw new Error('Invalid route response');
      return rows.map(row => `${row.gateway ?? 'on-link'} via ${row.dev ?? 'unknown'}`).slice(0, 32);
    }),
    probe('disks', () => command(['df', '-Pk', '/'])),
  ]);
  signal.throwIfAborted();
  const number = (text: string | null): number | null => {
    if (text === null || !text.trim()) return null;
    const value = Number(text); return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const kib = (field: string): number | null => {
    const match = memory?.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm'));
    return match ? Math.round(Number(match[1]) / 1024) : null;
  };
  return { version: 1, worldId: definition.worldId, workspaceId: definition.id, sessionId: agent.id, sampledAt: new Date().toISOString(),
    hostname, os: osRelease?.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? null, arch,
    cpuCount: number(cpu), memoryTotalMiB: kib('MemTotal'), memoryAvailableMiB: kib('MemAvailable'),
    uptimeSeconds: number(uptime?.trim().split(/\s+/)[0] ?? null), addresses: addresses ?? [], defaultRoutes: routes ?? [], disks, errors };
}
