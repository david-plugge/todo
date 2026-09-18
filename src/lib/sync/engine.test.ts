import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteQueue } from '../application/write-queue';
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
});
