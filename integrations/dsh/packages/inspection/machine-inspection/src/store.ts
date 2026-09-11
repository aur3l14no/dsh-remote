import { Service, type Context } from '@deepseek-ai/cordis';
import { defineDomain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { InspectionAttempt, MachineObservation } from './types.ts';

const text = z.string().max(65536);
const number = z.number().finite().nonnegative().nullable();
const observation = z.object({ version: z.literal(1), worldId: text, workspaceId: text, sessionId: text, sampledAt: text,
  hostname: text.nullable(), os: text.nullable(), arch: text.nullable(), cpuCount: number, memoryTotalMiB: number,
  memoryAvailableMiB: number, uptimeSeconds: number, addresses: z.array(z.object({ interface: text, address: text, family: text, state: text }).strict()).max(128),
  defaultRoutes: z.array(text).max(32), disks: text.nullable(), errors: z.array(z.object({ probe: text, message: text }).strict()).max(32),
}).strict();
const attempt = z.object({ id: text, worldId: text, name: text, childId: text, status: z.enum(['preparing', 'started', 'failed', 'cancelled']), at: text,
  workspaceId: text.optional(), path: text.optional(), error: text.optional() }).strict();
const schema = z.object({ rows: z.array(z.object({ leaderId: text, attempt, observation: observation.optional() }).strict()).max(8192) }).strict();
type State = z.infer<typeof schema>;
const spec = defineDomain({ name: 'machine_inspections', version: 1, global: { schema, initial: { rows: [] } }, tables: {} });

declare module '@deepseek-ai/cordis' { interface Context { machineInspections: InspectionStore } }

/** Latest report snapshots only. Native Sessions retain all conversation, lifecycle and tool history. */
export default class InspectionStore extends Service {
  static inject = ['storageDomain'];
  private state!: DomainGlobal<State>;
  private preparing = new Set<string>();
  isPreparing(id: string): boolean { return this.preparing.has(id); }
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: Context) { super(ctx, 'machineInspections'); }
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(spec);
    this.state = domain.global;
    this.ctx.effect(() => async () => { await this.tail; await domain.close(); });
  }
  forLeader(leaderId: string) { return this.state.get().rows.filter(row => row.leaderId === leaderId); }
  private update(change: (state: State) => State) {
    const pending = this.tail.then(() => this.state.set(change(this.state.get())));
    this.tail = pending.catch(() => {});
    return pending;
  }
  async begin(leaderId: string, value: InspectionAttempt) {
    const saved = attempt.parse(value);
    await this.update(state => ({ rows: [...state.rows.filter(row => row.leaderId !== leaderId || row.attempt.worldId !== value.worldId), { leaderId, attempt: saved }] }));
    this.preparing.add(value.id);
  }
  finish(leaderId: string, value: InspectionAttempt) {
    const saved = attempt.parse(value);
    return this.update(state => ({ rows: state.rows.map(row => row.leaderId === leaderId && row.attempt.id === saved.id ? { ...row, attempt: saved } : row) })).finally(() => this.preparing.delete(value.id));
  }
  observe(value: MachineObservation) {
    const saved = observation.parse(value);
    return this.update(state => ({ rows: state.rows.map(row => row.attempt.childId === saved.sessionId && row.attempt.worldId === saved.worldId
      ? { ...row, observation: saved } : row) }));
  }
}
