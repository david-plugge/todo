export interface WriteStatus {
  pending: number;
  error: string | null;
  message: string;
}

/** Serializes local transactions and drains accepted work before account storage closes. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private status: WriteStatus = { pending: 0, error: null, message: '' };
  private listeners = new Set<(status: Readonly<WriteStatus>) => void>();

  subscribe(listener: (status: Readonly<WriteStatus>) => void): () => void {
    this.listeners.add(listener);
    listener({ ...this.status });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(update: Partial<WriteStatus>) {
    this.status = { ...this.status, ...update };
    for (const listener of this.listeners) listener({ ...this.status });
  }

  run(action: () => Promise<unknown>): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    this.publish({ pending: this.status.pending + 1 });
    const result = this.tail.then(async () => {
      try {
        await action();
        this.publish({ error: null, message: 'Lokal atomar gespeichert' });
        return true;
      } catch {
        const message = 'Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.';
        this.publish({ error: message, message });
        return false;
      } finally {
        this.publish({ pending: this.status.pending - 1 });
      }
    });
    this.tail = result;
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.listeners.clear();
  }
}
