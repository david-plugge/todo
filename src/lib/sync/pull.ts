import { validEntity } from '../domain/validation';
import type { DexieAdapter } from '../db/adapter';
import type { Task, TaskList, SyncMetadata } from '../domain/models';
import { SnapshotResetWorker, type PullReset, type SnapshotPage } from './snapshot';

export interface RemoteChange {
  revision: number;
  entityType: 'task' | 'list';
  entityId: string;
  payload: Task | TaskList;
}
export interface PullPage {
  mode: 'changes';
  generation: string;
  changes: RemoteChange[];
  cursor: number;
  until: number;
  hasMore: boolean;
}
export interface PullTransport {
  fetchPage(
    after: number,
    until: number | undefined,
    limit: number,
    signal: AbortSignal,
    generation?: string,
  ): Promise<PullPage | PullReset>;
  fetchSnapshotPage?(
    generation: string,
    until: number,
    kind: 'task' | 'list',
    after: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<SnapshotPage>;
}
function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Validate before opening a local write transaction or advancing its durable cursor. */
function validate(
  page: PullPage,
  after: number,
  until: number | undefined,
  generation: string | undefined,
  ownerId: string,
  limit: number,
) {
  if (
    page?.mode !== 'changes' ||
    !validGeneration(page.generation) ||
    (generation !== undefined && page.generation !== generation) ||
    !Array.isArray(page.changes) ||
    page.changes.length > limit ||
    !Number.isSafeInteger(page.cursor) ||
    !Number.isSafeInteger(page.until) ||
    page.cursor < after ||
    page.until < page.cursor ||
    (until !== undefined && page.until !== until) ||
    typeof page.hasMore !== 'boolean'
  )
    throw new Error('Invalid pull page');
  let revision = after;
  for (const change of page.changes) {
    if (
      !change ||
      !validEntity(change.payload, change.entityType) ||
      !Number.isSafeInteger(change.revision) ||
      change.revision <= revision ||
      change.revision > page.until ||
      !['task', 'list'].includes(change.entityType) ||
      change.payload?.id !== change.entityId ||
      change.payload?.ownerId !== ownerId ||
      change.payload.remoteRevision !== change.revision ||
      !Number.isSafeInteger(change.payload.version) ||
      change.payload.version < 1
    )
      throw new Error('Invalid remote record or owner');
    revision = change.revision;
  }
  if (
    page.hasMore
      ? !page.changes.length || page.cursor !== revision || page.cursor >= page.until
      : page.cursor !== page.until
  )
    throw new Error('Invalid pull cursor');
}

export class PullWorker {
  private flight?: Promise<void>;
  private controller?: AbortController;
  constructor(
    private readonly adapter: DexieAdapter,
    private readonly transport: PullTransport,
    private readonly ownerId: string,
    private readonly limit = 50,
    private readonly deviceId?: string,
  ) {}
  pull(): Promise<void> {
    if (this.flight) return this.flight;
    this.controller = new AbortController();
    this.flight = this.run(this.controller.signal).finally(() => {
      this.flight = undefined;
      this.controller = undefined;
    });
    return this.flight;
  }
  cancel() {
    this.controller?.abort();
  }

  private async apply(change: RemoteChange) {
    const db = this.adapter.db;
    const key = `remote:${change.entityType}:${change.entityId}`;
    const pending = await db.outbox
      .where('entityId')
      .equals(change.entityId)
      .and((entry) => entry.entityType === change.entityType)
      .count();
    if (pending) {
      const previous = await db.syncMetadata.get(key);
      if (!previous || previous.revision < change.revision)
        await db.syncMetadata.put({ id: key, ...change });
      return;
    }
    const ackKey = `ack:${change.entityType}:${change.entityId}`;
    const accepted = await db.syncMetadata.get(ackKey);
    if (accepted && change.revision < accepted.revision) {
      await db.syncMetadata.delete(key);
      return;
    }
    const table = change.entityType === 'task' ? db.tasks : db.lists;
    const local = await table.get(change.entityId);
    if (!local || (local.remoteRevision ?? 0) < change.revision) {
      if (change.entityType === 'task') await db.tasks.put(change.payload as Task);
      else await db.lists.put(change.payload as TaskList);
    }
    await db.syncMetadata.delete(key);
    await db.syncMetadata.delete(ackKey);
  }

  private async drain() {
    await this.adapter.write(['tasks', 'lists', 'outbox'], async () => {
      const deferred = await this.adapter.db.syncMetadata
        .filter((row) => row.id.startsWith('remote:'))
        .toArray();
      for (const row of deferred) {
        if (row.entityType && row.entityId && row.payload)
          await this.apply(row as SyncMetadata & RemoteChange);
      }
    });
  }

  private async run(signal: AbortSignal) {
    await this.drain();
    let until: number | undefined;
    while (!signal.aborted) {
      const state = await this.adapter.db.syncMetadata.get('sync-state');
      const after =
        state?.cursor ?? (await this.adapter.db.syncMetadata.get('pull-cursor'))?.cursor ?? 0;
      const generation = state?.generation;
      if (until !== undefined && after >= until) break;
      const page = await this.transport.fetchPage(after, until, this.limit, signal, generation);
      signal.throwIfAborted();
      if (page.mode === 'reset') {
        await new SnapshotResetWorker(
          this.adapter,
          this.transport,
          this.ownerId,
          this.deviceId,
          this.limit,
        ).reset(page, signal);
        break;
      }
      validate(page, after, until, generation, this.ownerId, this.limit);
      until = page.until;
      const applied = await this.adapter.write(['tasks', 'lists', 'outbox'], async () => {
        signal.throwIfAborted();
        const currentState = await this.adapter.db.syncMetadata.get('sync-state');
        const current =
          currentState?.cursor ??
          (await this.adapter.db.syncMetadata.get('pull-cursor'))?.cursor ??
          0;
        // A second tab may already have advanced the shared cursor while HTTP was in flight.
        if (current !== after || currentState?.generation !== generation) return false;
        for (const change of page.changes) await this.apply(change);
        await this.adapter.db.syncMetadata.put({
          id: 'pull-cursor',
          revision: 0,
          cursor: page.cursor,
        });
        await this.adapter.db.syncMetadata.put({
          id: 'sync-state',
          revision: 0,
          generation: page.generation,
          cursor: page.cursor,
        });
        return true;
      });
      if (applied && !page.hasMore) break;
    }
    signal.throwIfAborted();
    await this.drain();
  }
}
