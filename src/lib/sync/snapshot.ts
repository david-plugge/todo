import type { DexieAdapter } from '../db/adapter';
import type { FieldVersion, OutboxEntry, Task, TaskList } from '../domain/models';
import { validEntity } from '../domain/validation';
import { listFields, taskFields, versions } from '../domain/versions';

export interface PullReset {
  mode: 'reset';
  generation: string;
  until: number;
}
export interface SnapshotPage {
  generation: string;
  until: number;
  kind: 'task' | 'list';
  records: (Task | TaskList)[];
  cursor: string;
  hasMore: boolean;
}
export interface SnapshotTransport {
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
function validateReset(reset: PullReset) {
  if (
    !reset ||
    reset.mode !== 'reset' ||
    !validGeneration(reset.generation) ||
    !Number.isSafeInteger(reset.until) ||
    reset.until < 0
  )
    throw new Error('Invalid snapshot reset');
}
function validatePage(
  page: SnapshotPage,
  reset: PullReset,
  kind: 'task' | 'list',
  after: string,
  ownerId: string,
  limit: number,
) {
  if (
    !page ||
    page.generation !== reset.generation ||
    page.until !== reset.until ||
    page.kind !== kind ||
    !Array.isArray(page.records) ||
    page.records.length > limit ||
    typeof page.cursor !== 'string' ||
    typeof page.hasMore !== 'boolean'
  )
    throw new Error('Invalid snapshot page');
  let cursor = after;
  for (const record of page.records) {
    if (
      !validEntity(record, kind) ||
      record.ownerId !== ownerId ||
      !Number.isSafeInteger(record.remoteRevision) ||
      record.remoteRevision! < 1 ||
      record.remoteRevision! > reset.until ||
      record.id <= cursor
    )
      throw new Error('Invalid snapshot record or owner');
    cursor = record.id;
  }
  if (
    (page.hasMore ? page.cursor !== cursor : page.cursor !== '') ||
    (page.hasMore && !page.records.length)
  )
    throw new Error('Invalid snapshot cursor');
}
function stampOrder(a: FieldVersion, b: FieldVersion) {
  return a.counter - b.counter || a.deviceId.localeCompare(b.deviceId);
}
function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sessionKey(sessionId: string) {
  return `snapshot-session:${sessionId}`;
}
function stagingPrefix(sessionId: string) {
  return `snapshot:${sessionId}:`;
}
function sessionIdFromKey(id: string) {
  return id.startsWith('snapshot-session:') ? id.slice('snapshot-session:'.length) : undefined;
}
function sessionIdFromStaging(id: string) {
  if (!id.startsWith('snapshot:')) return undefined;
  const rest = id.slice('snapshot:'.length);
  const separator = rest.indexOf(':');
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

const snapshotLeaseMs = 60_000;

/** Downloads a restore snapshot off to the side and swaps it in with one IndexedDB commit. */
export class SnapshotResetWorker {
  constructor(
    private readonly adapter: DexieAdapter,
    private readonly transport: SnapshotTransport,
    private readonly ownerId: string,
    private readonly deviceId: string | undefined,
    private readonly limit: number,
  ) {}

  async reset(reset: PullReset, signal: AbortSignal) {
    validateReset(reset);
    const fetch = this.transport.fetchSnapshotPage;
    if (!fetch) throw new Error('Snapshot transport unavailable');
    const sessionId = crypto.randomUUID();
    await this.adapter.write([], async () => {
      const createdAt = Date.now();
      await this.collectGarbage(createdAt);
      const state = await this.adapter.db.syncMetadata.get('sync-state');
      const sourceCursor =
        state?.cursor ?? (await this.adapter.db.syncMetadata.get('pull-cursor'))?.cursor ?? 0;
      await this.adapter.db.syncMetadata.put({
        id: sessionKey(sessionId),
        revision: 0,
        createdAt,
        leaseUntil: createdAt + snapshotLeaseMs,
        generation: reset.generation,
        until: reset.until,
        sourceGeneration: state?.generation,
        sourceCursor,
      });
    });
    try {
      for (const kind of ['list', 'task'] as const) {
        let after = '';
        while (!signal.aborted) {
          const page = await fetch(reset.generation, reset.until, kind, after, this.limit, signal);
          signal.throwIfAborted();
          validatePage(page, reset, kind, after, this.ownerId, this.limit);
          await this.adapter.write([], async () => {
            signal.throwIfAborted();
            const session = await this.adapter.db.syncMetadata.get(sessionKey(sessionId));
            if (session?.generation !== reset.generation || session.until !== reset.until)
              throw new Error('Snapshot session changed');
            session.leaseUntil = Date.now() + snapshotLeaseMs;
            await this.adapter.db.syncMetadata.put(session);
            for (const record of page.records)
              await this.adapter.db.syncMetadata.put({
                id: `${stagingPrefix(sessionId)}${kind}:${record.id}`,
                revision: record.remoteRevision!,
                generation: reset.generation,
                until: reset.until,
                kind,
                entityId: record.id,
                payload: record,
              });
          });
          after = page.cursor;
          if (!page.hasMore) break;
        }
        signal.throwIfAborted();
      }
      await this.install(reset, sessionId, signal);
    } catch (error) {
      await this.cleanup(sessionId);
      throw error;
    }
  }

  private mergeRecovery(local: Task | TaskList, remote: Task | TaskList) {
    const kind = 'title' in local ? 'task' : 'list';
    if (kind !== ('title' in remote ? 'task' : 'list')) throw new Error('Snapshot kind mismatch');
    const fields = kind === 'task' ? taskFields : listFields;
    const localStamps = versions(local);
    const remoteStamps = versions(remote);
    const merged = structuredClone(remote) as Task | TaskList;
    merged.fieldVersions = structuredClone(remoteStamps);
    let recover = false;
    for (const field of fields) {
      const order = stampOrder(localStamps[field], remoteStamps[field]);
      const localValue = (local as unknown as Record<string, unknown>)[field];
      const remoteValue = (remote as unknown as Record<string, unknown>)[field];
      if (!order && !sameValue(localValue, remoteValue))
        throw new Error('Field stamp reused with different value');
      if (order > 0) {
        recover = true;
        merged.fieldVersions[field] = structuredClone(localStamps[field]);
        if (localValue === undefined) delete (merged as unknown as Record<string, unknown>)[field];
        else (merged as unknown as Record<string, unknown>)[field] = structuredClone(localValue);
      }
    }
    merged.version = Math.max(
      local.version,
      remote.version,
      ...Object.values(merged.fieldVersions).map((stamp) => stamp.counter),
    );
    if (kind === 'task') {
      (merged as Task).createdAt = Math.min((local as Task).createdAt, (remote as Task).createdAt);
      (merged as Task).updatedAt = Math.max((local as Task).updatedAt, (remote as Task).updatedAt);
    }
    return { merged, recover };
  }

  private sameLegacyState(local: Task | TaskList, remote: Task | TaskList) {
    const kind = 'title' in local ? 'task' : 'list';
    if (kind !== ('title' in remote ? 'task' : 'list')) return false;
    const fields = kind === 'task' ? taskFields : listFields;
    const metadata =
      kind === 'task'
        ? (['id', 'ownerId', 'remoteRevision', 'version', 'createdAt', 'updatedAt'] as const)
        : (['id', 'ownerId', 'remoteRevision', 'version'] as const);
    const a = local as unknown as Record<string, unknown>;
    const b = remote as unknown as Record<string, unknown>;
    return [...fields, ...metadata].every((field) => sameValue(a[field], b[field]));
  }

  private recoveryEntry(
    kind: 'task' | 'list',
    entity: Task | TaskList,
    baseRevision: number,
  ): OutboxEntry {
    if (!this.deviceId) throw new Error('Device identity unavailable for snapshot recovery');
    return {
      id: crypto.randomUUID(),
      entityType: kind,
      entityId: entity.id,
      operation:
        entity.deletedAt !== undefined ? 'delete' : baseRevision === 0 ? 'create' : 'update',
      entityVersion: entity.version,
      createdAt: Date.now(),
      retryCount: 0,
      payload: structuredClone(entity),
      deviceId: this.deviceId,
      baseRevision,
    };
  }

  private async deleteSessionRows(sessionId: string) {
    const keys = await this.adapter.db.syncMetadata
      .filter(
        (row) => row.id === sessionKey(sessionId) || row.id.startsWith(stagingPrefix(sessionId)),
      )
      .primaryKeys();
    await this.adapter.db.syncMetadata.bulkDelete(keys);
  }

  /** Frees abandoned staging before a new snapshot needs quota; valid leases are never touched. */
  private async collectGarbage(now: number) {
    const metadata = this.adapter.db.syncMetadata;
    const keys = await metadata
      .filter(
        (row) =>
          row.id === 'snapshot-session' ||
          row.id.startsWith('snapshot-session:') ||
          row.id.startsWith('snapshot:'),
      )
      .primaryKeys();
    const sessionKeys = keys.filter((key) => key.startsWith('snapshot-session:'));
    const sessions = await metadata.bulkGet(sessionKeys);
    const live = new Set<string>();
    const remove = new Set<string>();
    sessionKeys.forEach((key, index) => {
      const sessionId = sessionIdFromKey(key);
      const session = sessions[index];
      if (
        sessionId &&
        session &&
        Number.isSafeInteger(session.createdAt) &&
        Number.isSafeInteger(session.leaseUntil) &&
        session.leaseUntil! > now
      )
        live.add(sessionId);
      else remove.add(key);
    });
    for (const key of keys) {
      if (key === 'snapshot-session') remove.add(key);
      if (key.startsWith('snapshot:')) {
        const sessionId = sessionIdFromStaging(key);
        if (!sessionId || !live.has(sessionId)) remove.add(key);
      }
    }
    if (remove.size) await metadata.bulkDelete([...remove]);
  }

  /** Drops sessions whose captured baseline can no longer pass the atomic install guard. */
  private async deleteSupersededSessions(
    generation: string | undefined,
    cursor: number,
    ownSessionId: string,
    now: number,
  ) {
    const metadata = this.adapter.db.syncMetadata;
    const keys = await metadata
      .filter(
        (row) =>
          row.id === 'snapshot-session' ||
          row.id.startsWith('snapshot-session:') ||
          row.id.startsWith('snapshot:'),
      )
      .primaryKeys();
    const sessionKeys = keys.filter((key) => key.startsWith('snapshot-session:'));
    const sessions = await metadata.bulkGet(sessionKeys);
    const retained = new Set<string>();
    const remove = new Set<string>();
    sessionKeys.forEach((key, index) => {
      const sessionId = sessionIdFromKey(key);
      const session = sessions[index];
      const targetAlreadyInstalled =
        session !== undefined &&
        session.generation === generation &&
        Number.isSafeInteger(session.until) &&
        session.until! <= cursor;
      if (
        sessionId &&
        sessionId !== ownSessionId &&
        session &&
        Number.isSafeInteger(session.createdAt) &&
        Number.isSafeInteger(session.leaseUntil) &&
        session.leaseUntil! > now &&
        session.sourceGeneration === generation &&
        session.sourceCursor === cursor &&
        !targetAlreadyInstalled
      )
        retained.add(sessionId);
      else remove.add(key);
    });
    for (const key of keys) {
      if (key === 'snapshot-session') remove.add(key);
      if (key.startsWith('snapshot:')) {
        const sessionId = sessionIdFromStaging(key);
        if (!sessionId || !retained.has(sessionId)) remove.add(key);
      }
    }
    if (remove.size) await metadata.bulkDelete([...remove]);
  }

  private async cleanup(sessionId: string) {
    await this.adapter.write([], () => this.deleteSessionRows(sessionId));
  }

  private async install(reset: PullReset, sessionId: string, signal: AbortSignal) {
    await this.adapter.write(['tasks', 'lists', 'outbox'], async () => {
      signal.throwIfAborted();
      const db = this.adapter.db;
      const session = await db.syncMetadata.get(sessionKey(sessionId));
      if (session?.generation !== reset.generation || session.until !== reset.until)
        throw new Error('Snapshot session changed');
      const currentState = await db.syncMetadata.get('sync-state');
      const currentCursor =
        currentState?.cursor ?? (await db.syncMetadata.get('pull-cursor'))?.cursor ?? 0;
      if (currentState?.generation === reset.generation && currentCursor >= reset.until) {
        await this.deleteSupersededSessions(
          currentState.generation,
          currentCursor,
          sessionId,
          Date.now(),
        );
        return;
      }
      if (
        currentState?.generation !== session.sourceGeneration ||
        currentCursor !== session.sourceCursor
      )
        throw new Error('Snapshot baseline changed');
      const staged = await db.syncMetadata
        .filter(
          (row) =>
            row.id.startsWith(stagingPrefix(sessionId)) &&
            row.generation === reset.generation &&
            row.until === reset.until,
        )
        .toArray();
      const snapshots = { task: new Map<string, Task>(), list: new Map<string, TaskList>() };
      for (const row of staged) {
        if (!row.kind || !row.entityId || !row.payload) throw new Error('Invalid staged snapshot');
        if (row.kind === 'task') snapshots.task.set(row.entityId, row.payload as Task);
        else snapshots.list.set(row.entityId, row.payload as TaskList);
      }
      const pending = await db.outbox.toArray();
      const pendingKeys = new Set(pending.map((entry) => `${entry.entityType}:${entry.entityId}`));
      const nextOutbox: OutboxEntry[] = pending.map((entry) => {
        const remote = snapshots[entry.entityType].get(entry.entityId);
        const next = structuredClone(entry);
        const baseRevision = remote?.remoteRevision ?? 0;
        if (next.deviceId) {
          // Idempotency receipts belong to the server generation that accepted them. A
          // delayed ACK from before a restore must never match a post-restore request.
          next.id = crypto.randomUUID();
          next.baseRevision = baseRevision;
        }
        next.retryCount = 0;
        delete next.nextAttemptAt;
        delete next.lastError;
        return next;
      });
      const installKind = async (kind: 'task' | 'list') => {
        const table = kind === 'task' ? db.tasks : db.lists;
        const local = new Map((await table.toArray()).map((row) => [row.id, row]));
        const remote = snapshots[kind];
        const result = new Map<string, Task | TaskList>();
        for (const id of new Set([...local.keys(), ...remote.keys()])) {
          const existing = local.get(id);
          const restored = remote.get(id);
          if (pendingKeys.has(`${kind}:${id}`)) {
            if (!existing) throw new Error('Pending mutation has no local record');
            result.set(id, existing);
          } else if (!existing && restored) result.set(id, restored);
          else if (existing && !restored) {
            const recovered = structuredClone(existing) as Task | TaskList;
            if (existing.fieldVersions)
              recovered.fieldVersions = structuredClone(versions(existing));
            recovered.remoteRevision = 0;
            result.set(id, recovered);
            nextOutbox.push(this.recoveryEntry(kind, recovered, 0));
          } else if (existing && restored) {
            if (!existing.fieldVersions) {
              const localRevision = existing.remoteRevision ?? 0;
              const restoredRevision = restored.remoteRevision ?? 0;
              if (localRevision > restoredRevision) {
                const recovered = structuredClone(existing) as Task | TaskList;
                recovered.remoteRevision = restoredRevision;
                result.set(id, recovered);
                nextOutbox.push(this.recoveryEntry(kind, recovered, restoredRevision));
              } else if (localRevision < restoredRevision) result.set(id, restored);
              else {
                if (!this.sameLegacyState(existing, restored))
                  throw new Error('Legacy snapshot revision reused with different value');
                result.set(id, restored);
              }
            } else {
              const { merged, recover } = this.mergeRecovery(existing, restored);
              result.set(id, merged);
              if (recover)
                nextOutbox.push(this.recoveryEntry(kind, merged, restored.remoteRevision ?? 0));
            }
          }
        }
        await table.clear();
        if (kind === 'task') await db.tasks.bulkPut([...result.values()] as Task[]);
        else await db.lists.bulkPut([...result.values()] as TaskList[]);
      };
      await installKind('list');
      await installKind('task');
      await db.outbox.clear();
      if (nextOutbox.length) await db.outbox.bulkPut(nextOutbox);
      await db.syncMetadata.put({
        id: 'sync-state',
        revision: 0,
        generation: reset.generation,
        cursor: reset.until,
      });
      await db.syncMetadata.put({ id: 'pull-cursor', revision: 0, cursor: reset.until });
      const obsolete = await db.syncMetadata
        .filter((row) => row.id.startsWith('ack:') || row.id.startsWith('remote:'))
        .primaryKeys();
      await db.syncMetadata.bulkDelete(obsolete);
      await this.deleteSupersededSessions(reset.generation, reset.until, sessionId, Date.now());
    });
  }
}
