import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteQueue } from '../application/write-queue';
import { Dexie } from 'dexie';
import { createStore } from '../db/store';
import type { TodoStore } from '../db/store';
import { SyncEngine } from './engine';

class RealtimeSubscriptions {
  readonly listeners = new Map<string, Set<() => void>>();
  globalUnsubscribes = 0;

  async subscribe(topic: string, callback: () => void) {
    const listeners = this.listeners.get(topic) ?? new Set();
    listeners.add(callback);
    this.listeners.set(topic, listeners);
    return async () => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(topic);
    };
  }

  async unsubscribe() {
    this.globalUnsubscribes++;
    this.listeners.clear();
  }

  count(topic: string) {
    return this.listeners.get(topic)?.size ?? 0;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushSubscriptions() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('account sync lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a replacement account subscribed while the previous write queue drains and closes', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', { onLine: false });
    const realtime = new RealtimeSubscriptions();
    const changes = new RealtimeSubscriptions();
    const pb = {
      realtime,
      collection: () => ({ subscribe: changes.subscribe.bind(changes) }),
    };
    const store = {
      ready: Promise.resolve(),
      adapter: {},
      db: { outbox: { toArray: async () => [] } },
    } as unknown as TodoStore;
    const previous = new SyncEngine(store, pb as never, 'previous', () => {});
    previous.start();
    await flushSubscriptions();

    const writes = new WriteQueue();
    const gate = deferred();
    const pendingWrite = writes.run(() => gate.promise);
    const closingPrevious = (async () => {
      await writes.close();
      await previous.close();
    })();

    const replacement = new SyncEngine(store, pb as never, 'replacement', () => {});
    replacement.start();
    await flushSubscriptions();
    expect(realtime.count('PB_CONNECT')).toBe(2);
    expect(changes.count('*')).toBe(2);

    gate.resolve();
    expect(await pendingWrite).toBe(true);
    await closingPrevious;

    expect(realtime.count('PB_CONNECT')).toBe(1);
    expect(changes.count('*')).toBe(1);
    expect(realtime.globalUnsubscribes).toBe(0);
    await replacement.close();
  });

  it('confirms generation by pulling before it pushes, then pulls the merged result', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', { onLine: true });
    const store = createStore(crypto.randomUUID(), {
      ownerId: 'owner',
      deviceId: '11111111-1111-4111-8111-111111111111',
    });
    await store.ready;
    await store.createTask('pending');
    const calls: string[] = [];
    const pb = {
      authStore: { record: { id: 'owner' } },
      send: async (path: string, options: { body?: Record<string, unknown> }) => {
        calls.push(path);
        if (path === '/api/todo/pull')
          return {
            mode: 'changes',
            generation: 'generation-a',
            changes: [],
            cursor: 0,
            until: 0,
            hasMore: false,
          };
        const mutation = options.body!;
        return {
          mutationId: mutation.id,
          entityId: mutation.entityId,
          entityType: mutation.entityType,
          entityVersion: mutation.entityVersion,
        };
      },
      realtime: new RealtimeSubscriptions(),
      collection: () => new RealtimeSubscriptions(),
    };
    const engine = new SyncEngine(store, pb as never, 'owner', () => {});
    await engine.sync();
    expect(calls).toEqual(['/api/todo/pull', '/api/todo/push', '/api/todo/pull']);
    expect(await store.db.outbox.count()).toBe(0);
    await engine.close();
    const name = store.db.name;
    await store.close();
    await Dexie.delete(name);
  });

  it('carries a wake from the run-finalizer window into a new sync flight', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', { onLine: true });
    const store = createStore(crypto.randomUUID(), {
      ownerId: 'owner',
      deviceId: '11111111-1111-4111-8111-111111111111',
    });
    await store.ready;
    let pulls = 0;
    const pb = {
      authStore: { record: { id: 'owner' } },
      send: async (path: string) => {
        if (path !== '/api/todo/pull') throw new Error(`Unexpected request: ${path}`);
        pulls++;
        return {
          mode: 'changes',
          generation: 'generation-a',
          changes: [],
          cursor: 0,
          until: 0,
          hasMore: false,
        };
      },
      realtime: new RealtimeSubscriptions(),
      collection: () => new RealtimeSubscriptions(),
    };
    let wake = () => {};
    let idle = 0;
    let secondIdle!: () => void;
    const completed = new Promise<void>((resolve) => {
      secondIdle = resolve;
    });
    const engine = new SyncEngine(store, pb as never, 'owner', (status) => {
      if (status.phase !== 'idle') return;
      idle++;
      if (idle === 1) queueMicrotask(wake);
      else secondIdle();
    });
    wake = () => engine.trigger();
    await engine.sync();
    await completed;
    expect(pulls).toBe(4);
    await engine.close();
    const name = store.db.name;
    await store.close();
    await Dexie.delete(name);
  });

  it('returns to idle when a recovery pull converges after a transient primary error', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', { onLine: true });
    const store = createStore(crypto.randomUUID(), {
      ownerId: 'owner',
      deviceId: '11111111-1111-4111-8111-111111111111',
    });
    await store.ready;
    let pulls = 0;
    const pb = {
      authStore: { record: { id: 'owner' } },
      send: async () => {
        pulls++;
        if (pulls === 1) throw Object.assign(new Error('temporary'), { status: 500 });
        return {
          mode: 'changes',
          generation: 'generation-a',
          changes: [],
          cursor: 0,
          until: 0,
          hasMore: false,
        };
      },
      realtime: new RealtimeSubscriptions(),
      collection: () => new RealtimeSubscriptions(),
    };
    const statuses: string[] = [];
    const engine = new SyncEngine(store, pb as never, 'owner', (status) =>
      statuses.push(`${status.phase}:${status.message}`),
    );
    await engine.sync();
    expect(pulls).toBe(2);
    expect(statuses.at(-1)).toBe('idle:Synchronisiert');
    await engine.close();
    const name = store.db.name;
    await store.close();
    await Dexie.delete(name);
  });
});
