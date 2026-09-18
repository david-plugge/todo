import PocketBase, { BaseAuthStore, LocalAuthStore } from 'pocketbase';
import { WriteQueue } from '../application/write-queue';
import { createStore, type WorkspaceStore } from '../db/store';
import { SyncEngine, type SyncStatus } from '../sync/engine';

export interface Account {
  ownerId: string;
  email: string;
  store: WorkspaceStore;
  writes: WriteQueue;
  engine: SyncEngine;
  onStatus: (callback: (status: SyncStatus) => void) => () => void;
  close: () => Promise<void>;
}

/** Auth is an application service; UI data access remains TanStack-only. */
export class AccountSession {
  private readonly pb = new PocketBase(location.origin, new LocalAuthStore('todo-auth-v1'));
  private current: Account | null = null;
  private ownerId?: string;
  private generation = 0;
  private activation = Promise.resolve();
  private listener?: (account: Account | null) => void;
  private unsubscribe?: () => void;
  private closed = false;
  hasCachedIdentity() {
    return this.pb.authStore.record?.collectionName === 'todo_users';
  }
  start(listener: (account: Account | null) => void, ready?: () => void) {
    this.listener = listener;
    let initialized = false;
    this.unsubscribe = this.pb.authStore.onChange(() => {
      void this.scheduleActivation().finally(() => {
        if (!initialized) {
          initialized = true;
          ready?.();
        }
      });
    }, true);
  }
  async login(email: string, password: string) {
    const isolated = new PocketBase(location.origin, new BaseAuthStore());
    const result = await isolated
      .collection('todo_users')
      .authWithPassword(email, password, { requestKey: null, signal: AbortSignal.timeout(10_000) });
    if (!this.closed) this.pb.authStore.save(result.token, result.record);
  }
  logout() {
    this.pb.authStore.clear();
  }
  private scheduleActivation() {
    const activation = this.activation.then(() => this.activate());
    // Keep the queue usable after an unexpected activation failure.
    this.activation = activation.catch(() => {});
    return activation;
  }
  private async activate() {
    if (this.closed) return;
    const record = this.pb.authStore.record;
    const owner = record?.collectionName === 'todo_users' ? record.id : undefined;
    if (owner === this.ownerId) return;
    this.ownerId = owner;
    const generation = ++this.generation;
    const previous = this.current;
    this.current = null;
    this.listener?.(null);
    await previous?.close();
    if (this.closed || generation !== this.generation || !owner) return;
    let deviceId = localStorage.getItem('todo-device-id');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('todo-device-id', deviceId);
    }
    const store = createStore(`todo-account-${owner}`, {
      ownerId: owner,
      deviceId,
      onLocalWrite: () => engine.trigger(),
    });
    let status: SyncStatus = { phase: 'idle', message: 'Lokale Daten werden geladen …' };
    const listeners = new Set<(value: SyncStatus) => void>();
    const engine = new SyncEngine(store, this.pb, owner, (next) => {
      status = next;
      listeners.forEach((fn) => fn(next));
    });
    const writes = new WriteQueue();
    this.current = {
      ownerId: owner,
      email: String(record?.email ?? ''),
      store,
      engine,
      writes,
      onStatus(callback) {
        listeners.add(callback);
        callback(status);
        return () => {
          listeners.delete(callback);
        };
      },
      async close() {
        await writes.close();
        await engine.close();
        await store.close();
      },
    };
    this.listener?.(this.current);
    engine.start();
    // Refresh may fail offline/expired. Cached identity and IndexedDB still open immediately.
    const refresh = new PocketBase(location.origin, new BaseAuthStore());
    refresh.authStore.save(this.pb.authStore.token, record);
    void refresh
      .collection('todo_users')
      .authRefresh({ requestKey: null, signal: AbortSignal.timeout(10_000) })
      .then((result) => {
        if (!this.closed && generation === this.generation) {
          this.pb.authStore.save(result.token, result.record);
          engine.trigger();
        }
      })
      .catch(() => {});
  }
  async close() {
    this.closed = true;
    ++this.generation;
    this.unsubscribe?.();
    this.pb.cancelAllRequests();
    await this.activation;
    await this.current?.close();
    this.current = null;
  }
}
