import type { OutboxEntry } from '../domain/models';
import type { DexieAdapter } from '../db/adapter';

export type PushMutation = Pick<
  OutboxEntry,
  | 'id'
  | 'entityId'
  | 'entityType'
  | 'entityVersion'
  | 'operation'
  | 'payload'
  | 'deviceId'
  | 'baseRevision'
>;
export interface PushAck {
  mutationId: string;
  entityId: string;
  entityType: OutboxEntry['entityType'];
  entityVersion: number;
  serverRevision?: number;
}
export interface PushTransport {
  // Must be idempotent by mutation.id, validate immutable payloads, and honor cancellation.
  send(mutation: PushMutation, generation: string, signal: AbortSignal): Promise<PushAck>;
}

export function matchesAck(entry: PushMutation, ack: PushAck): boolean {
  return (
    ack?.mutationId === entry.id &&
    ack.entityId === entry.entityId &&
    ack.entityType === entry.entityType &&
    ack.entityVersion === entry.entityVersion &&
    (ack.serverRevision === undefined ||
      (Number.isSafeInteger(ack.serverRevision) && ack.serverRevision > 0))
  );
}

/** A bounded push pass. New local writes are intentionally left for the next pass. */
export class PushWorker {
  private flight?: Promise<number>;
  private controller?: AbortController;

  constructor(
    private readonly adapter: DexieAdapter,
    private readonly transport: PushTransport,
    private readonly options: { now?: () => number; timeoutMs?: number } = {},
  ) {}

  push(): Promise<number> {
    if (this.flight) return this.flight;
    this.controller = new AbortController();
    this.flight = this.run(this.controller.signal).finally(() => {
      this.flight = undefined;
      this.controller = undefined;
    });
    return this.flight;
  }

  cancel() {
    this.controller?.abort(new DOMException('Push cancelled', 'AbortError'));
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private async run(signal: AbortSignal): Promise<number> {
    // All entries come from committed IndexedDB, never an optimistic Collection view.
    const entries = (await this.adapter.db.outbox.toArray()).sort(
      (a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.entityId.localeCompare(b.entityId) ||
        a.entityVersion - b.entityVersion ||
        a.id.localeCompare(b.id),
    );
    if (!entries.length) return 0;
    const generation = (await this.adapter.db.syncMetadata.get('sync-state'))?.generation;
    if (!generation) throw new Error('Sync generation has not been confirmed');
    let acknowledged = 0;
    const blocked = new Set<string>();
    for (const entry of entries) {
      signal.throwIfAborted();
      const key = `${entry.entityType}/${entry.entityId}`;
      if (blocked.has(key)) continue;
      if ((entry.nextAttemptAt ?? 0) > this.now()) {
        blocked.add(key);
        continue;
      }
      const { id, entityId, entityType, entityVersion, operation, payload } = entry;
      const mutation = {
        id,
        entityId,
        entityType,
        entityVersion,
        operation,
        payload,
        ...(entry.deviceId
          ? { deviceId: entry.deviceId, baseRevision: entry.baseRevision ?? 0 }
          : {}),
      };
      if (payload.id !== entityId || payload.version !== entityVersion)
        throw new Error('Invalid outbox snapshot');
      try {
        const ack = await this.send(mutation, generation, signal);
        signal.throwIfAborted();
        if (!matchesAck(mutation, ack)) throw new Error('ACK does not match the sent mutation');
        const applied = await this.adapter.write(
          ack.serverRevision === undefined
            ? ['outbox']
            : ['outbox', entityType === 'task' ? 'tasks' : 'lists'],
          async () => {
            const currentGeneration = (await this.adapter.db.syncMetadata.get('sync-state'))
              ?.generation;
            // A restore may have rebound every pending request to a new idempotency domain
            // while this request was in flight. An ACK from that old generation is inert.
            if (currentGeneration !== generation) return false;
            const pending = await this.adapter.db.outbox.get(id);
            // A different tab may already have acknowledged the same immutable mutation.
            if (!pending) return false;
            if (!matchesAck(pending, ack)) throw new Error('ACK does not match pending mutation');
            // Keep an acknowledged local snapshot ahead of any older deferred pull.
            // A newer local version stays pending and receives no blanket synced flag.
            if (ack.serverRevision !== undefined) {
              const table = entityType === 'task' ? this.adapter.db.tasks : this.adapter.db.lists;
              const local = await table.get(entityId);
              if (payload.fieldVersions) {
                // ACK confirms acceptance, not the merged values. Only pull may install those.
                const key = `ack:${entityType}:${entityId}`;
                const previous = await this.adapter.db.syncMetadata.get(key);
                await this.adapter.db.syncMetadata.put({
                  id: key,
                  revision: Math.max(previous?.revision ?? 0, ack.serverRevision),
                });
              } else if (local?.version === entityVersion)
                await table.update(entityId, {
                  remoteRevision: Math.max(local.remoteRevision ?? 0, ack.serverRevision),
                });
            }
            await this.adapter.db.outbox.delete(id);
            return true;
          },
        );
        if (applied) acknowledged++;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        await this.adapter.write(['outbox'], async () => {
          const pending = await this.adapter.db.outbox.get(id);
          if (!pending) return;
          const retryCount = pending.retryCount + 1;
          await this.adapter.db.outbox.update(id, {
            retryCount,
            nextAttemptAt: this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(retryCount - 1, 6)),
            lastError: error instanceof Error ? error.message : String(error),
          });
        });
        throw error;
      }
    }
    return acknowledged;
  }

  private async send(
    mutation: PushMutation,
    generation: string,
    parent: AbortSignal,
  ): Promise<PushAck> {
    const request = new AbortController();
    const cancel = () => request.abort(parent.reason);
    parent.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => request.abort(new DOMException('Push timed out', 'TimeoutError')),
      this.options.timeoutMs ?? 10_000,
    );
    let rejectAbort: (() => void) | undefined;
    try {
      if (parent.aborted) cancel();
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', rejectAbort, { once: true });
        if (request.signal.aborted) rejectAbort();
      });
      return await Promise.race([
        this.transport.send(mutation, generation, request.signal),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', cancel);
      if (rejectAbort) request.signal.removeEventListener('abort', rejectAbort);
    }
  }
}
