import type PocketBase from 'pocketbase';
import type { TodoStore } from '../db/store';
import { pocketBaseTransport } from '../pocketbase/transport';
import { PushWorker } from './push';
import { PullWorker } from './pull';

export interface SyncStatus {
  phase: 'idle' | 'syncing' | 'offline' | 'error' | 'paused';
  message: string;
}
export class SyncEngine {
  private readonly pushWorker: PushWorker;
  private readonly pullWorker: PullWorker;
  private disposed = false;
  private paused = false;
  private flight?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribeConnect?: () => Promise<void>;
  private unsubscribeChanges?: () => Promise<void>;
  private cleanupEvents?: () => void;
  constructor(
    private readonly store: TodoStore,
    private readonly pb: PocketBase,
    ownerId: string,
    private readonly status: (status: SyncStatus) => void,
  ) {
    const transport = pocketBaseTransport(pb, ownerId);
    this.pushWorker = new PushWorker(store.adapter, transport);
    this.pullWorker = new PullWorker(
      store.adapter,
      transport,
      ownerId,
      50,
      store.syncIdentity?.deviceId,
    );
  }
  start() {
    const wake = () => this.trigger();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    this.cleanupEvents = () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
    // Reconnects also cause a pull; SSE payloads never enter IndexedDB here.
    void this.pb.realtime
      .subscribe('PB_CONNECT', wake)
      .then((unsubscribe) => {
        if (this.disposed) void unsubscribe();
        else this.unsubscribeConnect = unsubscribe;
      })
      .catch(() => {});
    void this.pb
      .collection('todo_changes')
      .subscribe('*', wake)
      .then((unsubscribe) => {
        if (this.disposed) unsubscribe();
        else this.unsubscribeChanges = unsubscribe;
      })
      .catch(() => {});
    this.trigger();
  }
  trigger() {
    if (!this.disposed && !this.paused) void this.sync().catch(() => {});
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      this.pushWorker.cancel();
      this.pullWorker.cancel();
      clearTimeout(this.timer);
      this.status({
        phase: 'paused',
        message: 'Sync pausiert · lokale Änderungen bleiben pending',
      });
    } else this.trigger();
  }
  sync(): Promise<void> {
    if (this.disposed || this.paused) return Promise.resolve();
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    this.flight = this.run().finally(() => {
      const restart = this.again && !this.disposed && !this.paused;
      this.flight = undefined;
      // A wake queued after run()'s final loop check but before this finalizer still
      // observed the old flight. Carry that wake into a fresh flight instead of losing it.
      if (restart) {
        this.again = false;
        void this.sync().catch(() => {});
      }
    });
    return this.flight;
  }
  async pull() {
    if (!this.disposed && !this.paused) {
      await this.store.ready;
      await this.pullWorker.pull();
    }
  }
  private async run() {
    clearTimeout(this.timer);
    await this.store.ready;
    do {
      this.again = false;
      if (this.disposed || this.paused) return;
      if (!navigator.onLine) {
        this.status({ phase: 'offline', message: 'Offline · lokale Daten verfügbar' });
        return;
      }
      this.status({ phase: 'syncing', message: 'Synchronisiere …' });
      try {
        await this.pullWorker.pull();
        await this.pushWorker.push();
        await this.pullWorker.pull();
        if (this.disposed || this.paused) return;
        const pending = await this.store.db.outbox.toArray();
        this.status({
          phase: 'idle',
          message: pending.length
            ? `${pending.length} Änderung(en) warten auf Retry`
            : 'Synchronisiert',
        });
        if (pending.length)
          this.timer = setTimeout(
            () => this.trigger(),
            Math.max(
              1000,
              Math.min(...pending.map((e) => e.nextAttemptAt ?? Date.now())) - Date.now(),
            ),
          );
      } catch (error) {
        if (this.disposed || this.paused) return;
        const code = (error as { status?: number }).status;
        this.status({
          phase: 'error',
          message:
            code === 401 || code === 403
              ? 'Anmeldung erneuern · lokale Daten bleiben verfügbar'
              : code === 409
                ? 'Eine Änderung konnte nicht abgeglichen werden und bleibt lokal gespeichert.'
                : 'Synchronisierung fehlgeschlagen. Deine Änderungen bleiben lokal gespeichert.',
        });
        if (code !== 401 && code !== 403 && code !== 409)
          this.timer = setTimeout(() => this.trigger(), 5000);
        // Pull independent entities even when a pending push conflicts; reconcile defers its entity.
        try {
          await this.pullWorker.pull();
          const pending = await this.store.db.outbox.toArray();
          if (!pending.length) {
            clearTimeout(this.timer);
            this.status({ phase: 'idle', message: 'Synchronisiert' });
          }
        } catch {
          /* Original sync error stays visible. */
        }
        return;
      }
    } while (this.again);
  }
  async close() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.cleanupEvents?.();
    await Promise.allSettled([this.unsubscribeConnect?.(), this.unsubscribeChanges?.()]);
    this.pushWorker.cancel();
    this.pullWorker.cancel();
    await this.flight?.catch(() => {});
  }
}
