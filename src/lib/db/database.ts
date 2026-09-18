import { Dexie, type Table } from 'dexie';
import type { Task, TaskList, OutboxEntry, SyncMetadata } from '../domain/models';

export class TodoDatabase extends Dexie {
  tasks!: Table<Task, string>;
  lists!: Table<TaskList, string>;
  outbox!: Table<OutboxEntry, string>;
  syncMetadata!: Table<SyncMetadata, string>;

  constructor(name = 'todo-spike-v1') {
    super(name, { chromeTransactionDurability: 'strict' });
    this.version(1).stores({
      tasks: 'id',
      lists: 'id',
      outbox: 'id, entityId, [entityType+entityId+entityVersion]',
      syncMetadata: 'id',
    });
    this.version(2)
      .stores({})
      .upgrade(async (tx) => {
        // v1 never pushed: only the current record can reconstruct a truthful snapshot.
        // Coalesce legacy entries for an entity instead of inventing historical payloads.
        const legacy = await tx.table<OutboxEntry>('outbox').toArray();
        const groups = new Map<string, OutboxEntry[]>();
        for (const entry of legacy) {
          const key = `${entry.entityType}/${entry.entityId}`;
          groups.set(key, [...(groups.get(key) ?? []), entry]);
        }
        for (const entries of groups.values()) {
          const latest = entries.sort((a, b) => b.entityVersion - a.entityVersion)[0];
          const entity = await tx
            .table(latest.entityType === 'task' ? 'tasks' : 'lists')
            .get(latest.entityId);
          if (!entity || entity.version !== latest.entityVersion)
            throw new Error('Cannot reconstruct legacy outbox snapshot');
          await tx.table('outbox').bulkDelete(entries.map((entry) => entry.id));
          await tx.table('outbox').add({ ...latest, payload: entity });
        }
        if (legacy.length) {
          const metadata = tx.table('syncMetadata');
          const revision = ((await metadata.get('adapter-revision'))?.revision ?? 0) + 1;
          await metadata.put({ id: 'adapter-revision', revision });
        }
      });
  }
}
