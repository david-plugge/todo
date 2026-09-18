import { createCollection, type Collection, type MutationFn, type SyncConfig } from '@tanstack/db';
import { liveQuery, type Table } from 'dexie';
import type { TodoDatabase } from './database';

type Row = { id: string };
type Sink<T extends Row> = Parameters<SyncConfig<T, string>['sync']>[0];
const revisionKey = 'adapter-revision';
export type DataTable = 'tasks' | 'lists' | 'outbox';

/** All collections belong to one database; one mutationFn owns the whole commit. */
export class DexieAdapter {
  private bindings = new Map<
    object,
    { table: Table<Row, string>; publish: (revision: number, rows: Row[]) => void }
  >();

  constructor(readonly db: TodoDatabase) {}

  collection<T extends Row>(table: Table<T, string>): Collection<T, string> {
    if (table.db !== this.db) throw new Error('Collections must share one Dexie database');
    let sink: Sink<T> | undefined;
    let previous = new Map<string, T>();
    let observedRevision = -1;
    const publish = (revision: number, rows: T[]) => {
      if (!sink || revision <= observedRevision) return;
      const next = new Map(rows.map((row) => [row.id, row]));
      sink.begin();
      for (const row of rows) {
        const old = previous.get(row.id);
        if (!old) sink.write({ type: 'insert', value: row });
        else if (JSON.stringify(old) !== JSON.stringify(row))
          sink.write({ type: 'update', value: row });
      }
      for (const [id, row] of previous) {
        if (!next.has(id)) sink.write({ type: 'delete', value: row });
      }
      // Do not await the receipt: normal sync publication may wait for mutationFn.
      const receipt = sink.commit();
      if (receipt !== true) void receipt.catch(() => {});
      previous = next;
      observedRevision = revision;
      sink.markReady();
    };
    const collection = createCollection<T, string>({
      id: `${this.db.name}/${table.name}`,
      getKey: (row) => row.id,
      startSync: true,
      gcTime: Infinity,
      sync: {
        rowUpdateMode: 'full',
        sync: (params) => {
          sink = params;
          observedRevision = -1;
          previous = new Map();
          const subscription = liveQuery(() =>
            this.db.transaction('r', table, this.db.syncMetadata, async () => ({
              rows: await table.toArray(),
              revision: (await this.db.syncMetadata.get(revisionKey))?.revision ?? 0,
            })),
          ).subscribe({
            next: (snapshot) => publish(snapshot.revision, snapshot.rows),
            error: (error) => params.markError(error),
          });
          return () => {
            subscription.unsubscribe();
            sink = undefined;
          };
        },
      },
      // No implicit handlers: writes must use the shared manual transaction.
    });
    this.bindings.set(collection, {
      table: table as Table<Row, string>,
      publish: (revision, rows) => publish(revision, rows as T[]),
    });
    return collection;
  }

  persist: MutationFn = async ({ transaction }) => {
    const writes = transaction.mutations.map((mutation) => {
      const binding = this.bindings.get(mutation.collection);
      if (!binding) throw new Error('Unregistered collection in local transaction');
      return { mutation, binding };
    });
    const tableNames = [...new Set(writes.map((write) => write.binding.table.name as DataTable))];
    await this.write(tableNames, async () => {
      for (const {
        mutation,
        binding: { table },
      } of writes) {
        if (mutation.type === 'insert') {
          // add, not put: duplicate keys must abort the entire transaction.
          await table.add(mutation.modified as Row);
        } else {
          const current = await table.get(mutation.key);
          if (JSON.stringify(current) !== JSON.stringify(mutation.original)) {
            throw new Error(`Stale local write: ${table.name}/${mutation.key}; refresh and retry`);
          }
          if (mutation.type === 'delete') await table.delete(mutation.key);
          else await table.put(mutation.modified as Row);
        }
      }
    });
  };

  /** Internal local-only write path for ACK/retry; never pass network work here. */
  async write<T>(names: DataTable[], mutate: () => Promise<T>): Promise<T> {
    const tables = [...new Set(names)].map((name) => this.db.table(name));
    const snapshot = await this.db.transaction(
      'rw',
      [...tables, this.db.syncMetadata],
      async () => {
        const result = await mutate();
        const revision = ((await this.db.syncMetadata.get(revisionKey))?.revision ?? 0) + 1;
        await this.db.syncMetadata.put({ id: revisionKey, revision });
        const rows = await Promise.all(tables.map((table) => table.toArray()));
        return { revision, rows, result };
      },
    );
    // Only publish after native commit. Revision guards reject older liveQuery snapshots.
    for (const binding of this.bindings.values()) {
      const index = tables.findIndex((table) => table.name === binding.table.name);
      if (index !== -1) binding.publish(snapshot.revision, snapshot.rows[index]);
    }
    return snapshot.result;
  }
}
