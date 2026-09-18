import { afterEach, describe, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { createStore } from '../db/store';
import { PushWorker, type PushAck, type PushMutation, type PushTransport } from './push';

const stores: ReturnType<typeof createStore>[] = [];
async function open(name: string = crypto.randomUUID()) {
  const store = createStore(name);
  stores.push(store);
  await store.ready;
  return store;
}
afterEach(async () => {
  const opened = stores.splice(0);
  for (const store of opened) await store.close();
  for (const name of new Set(opened.map((store) => store.db.name))) await Dexie.delete(name);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function ack(m: PushMutation): PushAck {
  return {
    mutationId: m.id,
    entityId: m.entityId,
    entityType: m.entityType,
    entityVersion: m.entityVersion,
  };
}
class TestRemote implements PushTransport {
  mutations = new Map<string, PushMutation>();
  records = new Map<string, PushMutation['payload']>();
  requests: PushMutation[] = [];
  async send(m: PushMutation): Promise<PushAck> {
    expect(Dexie.currentTransaction).toBeNull();
    this.requests.push(structuredClone(m));
    const previous = this.mutations.get(m.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(m))
      throw new Error('idempotency key reused');
    this.mutations.set(m.id, structuredClone(m));
    const key = `${m.entityType}/${m.entityId}`;
    const record = this.records.get(key);
    if (!record || record.version < m.entityVersion)
      this.records.set(key, structuredClone(m.payload));
    return ack(m);
  }
}

describe('Spike 5: immutable push snapshots, ACK and restart safety', () => {
  it('ACK v5 keeps v6 pending; pushing v6 converges and clears only that revision', async () => {
    const store = await open();
    const remote = new TestRemote();
    const id = await store.createTask('v1');
    for (let v = 2; v <= 4; v++) await store.changeTask(id, { title: `v${v}` });
    await new PushWorker(store.adapter, remote).push();
    await store.changeTask(id, { title: 'v5' });
    const started = deferred<PushMutation>();
    const release = deferred<PushAck>();
    const worker = new PushWorker(store.adapter, {
      send: async (m) => {
        await remote.send(m);
        started.resolve(m);
        return release.promise;
      },
    });
    const push = worker.push();
    const sent = await started.promise;
    expect(sent.payload).toMatchObject({ title: 'v5', version: 5 });
    await store.changeTask(id, { title: 'v6', completed: true });
    release.resolve(ack(sent));
    await push;
    expect(await store.db.outbox.toArray()).toEqual([
      expect.objectContaining({
        entityVersion: 6,
        payload: expect.objectContaining({ title: 'v6' }),
      }),
    ]);
    expect(store.tasks.get(id)).toMatchObject({ title: 'v6', completed: true, version: 6 });
    expect(remote.records.get(`task/${id}`)).toMatchObject({ title: 'v5', version: 5 });
    await new PushWorker(store.adapter, remote).push();
    expect(await store.db.outbox.count()).toBe(0);
    expect(remote.records.get(`task/${id}`)).toMatchObject({
      title: 'v6',
      version: 6,
      completed: true,
    });
  });

  it('old payloads remain immutable and contain no TanStack virtual properties', async () => {
    const store = await open();
    const id = await store.createTask('old');
    await store.changeTask(id, { title: 'new' });
    const entries = (await store.db.outbox.toArray()).sort(
      (a, b) => a.entityVersion - b.entityVersion,
    );
    expect(entries.map((entry) => entry.payload)).toMatchObject([
      { title: 'old', version: 1 },
      { title: 'new', version: 2 },
    ]);
    expect(JSON.stringify(entries)).not.toContain('$');
    const remote = new TestRemote();
    await new PushWorker(store.adapter, remote).push();
    expect(remote.requests.map((m) => m.entityVersion)).toEqual([1, 2]);
  });

  it('lost ACK after remote apply survives reopen and retries the same idempotency key', async () => {
    const store = await open();
    const id = await store.createTask('at least once');
    const remote = new TestRemote();
    let now = 0;
    await expect(
      new PushWorker(
        store.adapter,
        {
          send: async (m) => {
            await remote.send(m);
            throw new Error('connection lost after commit');
          },
        },
        { now: () => now },
      ).push(),
    ).rejects.toThrow('connection lost');
    const [pending] = await store.db.outbox.toArray();
    expect(pending).toMatchObject({ retryCount: 1, nextAttemptAt: 1000 });
    await store.close();
    const reopened = await open(store.db.name);
    const worker = new PushWorker(reopened.adapter, remote, { now: () => now });
    expect(await worker.push()).toBe(0);
    now = 1000;
    expect(await worker.push()).toBe(1);
    expect(remote.requests).toHaveLength(2);
    expect(remote.requests[0]).toEqual(remote.requests[1]);
    expect(remote.mutations.size).toBe(1);
    expect(remote.records.size).toBe(1);
    expect(await reopened.db.outbox.count()).toBe(0);
    expect(reopened.tasks.get(id)?.title).toBe('at least once');
  });

  it('backoff for an older revision also blocks newer revisions of that entity', async () => {
    const store = await open();
    const id = await store.createTask('v1');
    await expect(
      new PushWorker(
        store.adapter,
        {
          send: async () => {
            throw new Error('offline');
          },
        },
        { now: () => 0 },
      ).push(),
    ).rejects.toThrow('offline');
    await store.changeTask(id, { title: 'v2' });
    const remote = new TestRemote();
    expect(await new PushWorker(store.adapter, remote, { now: () => 500 }).push()).toBe(0);
    expect(remote.requests).toHaveLength(0);
    expect(await new PushWorker(store.adapter, remote, { now: () => 1000 }).push()).toBe(2);
    expect(remote.requests.map((m) => m.entityVersion)).toEqual([1, 2]);
  });

  it('rejects wrong ACK versions and preserves all pending writes', async () => {
    const store = await open();
    await store.createTask('unconfirmed');
    await expect(
      new PushWorker(store.adapter, {
        send: async (m) => ({ ...ack(m), entityVersion: 100 }),
      }).push(),
    ).rejects.toThrow('ACK does not match');
    expect(await store.db.outbox.count()).toBe(1);
    expect((await store.db.outbox.toArray())[0].retryCount).toBe(1);
  });

  it('an ACK transaction failure keeps the outbox; retry can finish safely', async () => {
    const store = await open();
    await store.createTask('ack durability');
    const remote = new TestRemote();
    const rejectDelete = () => {
      throw new Error('local ACK storage failed');
    };
    store.db.outbox.hook('deleting', rejectDelete);
    await expect(new PushWorker(store.adapter, remote, { now: () => 0 }).push()).rejects.toThrow(
      'local ACK storage failed',
    );
    expect(await store.db.outbox.count()).toBe(1);
    store.db.outbox.hook('deleting').unsubscribe(rejectDelete);
    await new PushWorker(store.adapter, remote, { now: () => 1000 }).push();
    expect(remote.mutations.size).toBe(1);
    expect(await store.db.outbox.count()).toBe(0);
  });

  it('single flight, cancellation and retry after restart do not strand in-flight entries', async () => {
    const store = await open();
    await store.createTask('cancel');
    const started = deferred<void>();
    const worker = new PushWorker(store.adapter, {
      send: async () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    const first = worker.push();
    expect(worker.push()).toBe(first);
    await started.promise;
    worker.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((await store.db.outbox.toArray())[0]).toMatchObject({ retryCount: 0 });
    await store.close();
    const reopened = await open(store.db.name);
    await new PushWorker(reopened.adapter, new TestRemote()).push();
    expect(await reopened.db.outbox.count()).toBe(0);
  });

  it('times out even an unresponsive transport and stores a bounded retry delay', async () => {
    const store = await open();
    await store.createTask('timeout');
    const worker = new PushWorker(
      store.adapter,
      { send: () => new Promise(() => {}) },
      { timeoutMs: 10, now: () => 200 },
    );
    await expect(worker.push()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await store.db.outbox.toArray())[0]).toMatchObject({
      retryCount: 1,
      nextAttemptAt: 1200,
    });
  });

  it('two tab workers may duplicate a push but both ACKs are safe', async () => {
    const first = await open();
    await first.createTask('two workers');
    const second = await open(first.db.name);
    const remote = new TestRemote();
    const both = deferred<void>();
    let calls = 0;
    const transport = {
      send: async (m: PushMutation) => {
        calls++;
        if (calls === 2) both.resolve();
        await both.promise;
        return remote.send(m);
      },
    };
    await Promise.all([
      new PushWorker(first.adapter, transport).push(),
      new PushWorker(second.adapter, transport).push(),
    ]);
    expect(remote.requests).toHaveLength(2);
    expect(remote.mutations.size).toBe(1);
    expect(await first.db.outbox.count()).toBe(0);
    await expect.poll(() => second.outbox.size).toBe(0);
  });

  it('a delayed old request cannot resurrect a later tombstone at an idempotent remote', async () => {
    const store = await open();
    const id = await store.createTask('delete');
    await store.changeTask(id, { deletedAt: 123 });
    const remote = new TestRemote();
    await new PushWorker(store.adapter, remote).push();
    await remote.send(remote.requests[0]);
    expect(remote.records.get(`task/${id}`)).toMatchObject({ deletedAt: 123, version: 2 });
    expect(store.tasks.get(id)?.deletedAt).toBe(123);
  });
});
