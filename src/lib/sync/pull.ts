import { validEntity } from '../domain/validation';
import type { DexieAdapter } from '../db/adapter';
import type { Task, TaskList, SyncMetadata } from '../domain/models';

export interface RemoteChange {
  revision: number;
  entityType: 'task' | 'list';
  entityId: string;
  payload: Task | TaskList;
}
export interface PullPage {
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
  ): Promise<PullPage>;
}

/** Validate before opening a local write transaction or advancing its durable cursor. */
function validate(
  page: PullPage,
  after: number,
  until: number | undefined,
  ownerId: string,
  limit: number,
) {
  if (
    !page ||
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
      const after = (await this.adapter.db.syncMetadata.get('pull-cursor'))?.cursor ?? 0;
      if (until !== undefined && after >= until) break;
      const page = await this.transport.fetchPage(after, until, this.limit, signal);
      signal.throwIfAborted();
      validate(page, after, until, this.ownerId, this.limit);
      until = page.until;
      const applied = await this.adapter.write(['tasks', 'lists', 'outbox'], async () => {
        signal.throwIfAborted();
        const current = (await this.adapter.db.syncMetadata.get('pull-cursor'))?.cursor ?? 0;
        // A second tab may already have advanced the shared cursor while HTTP was in flight.
        if (current !== after) return false;
        for (const change of page.changes) await this.apply(change);
        await this.adapter.db.syncMetadata.put({
          id: 'pull-cursor',
          revision: 0,
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
