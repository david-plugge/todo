import { describe, expect, it } from 'vitest';
import { WriteQueue } from './write-queue';

describe('account write lifecycle', () => {
  it('drains accepted edits in order before close and rejects new writes', async () => {
    const queue = new WriteQueue();
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      await gate;
      order.push(1);
    });
    const second = queue.run(async () => {
      order.push(2);
    });
    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    expect(
      await queue.run(async () => {
        order.push(3);
      }),
    ).toBe(false);
    expect(closed).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await closing;
    expect(order).toEqual([1, 2]);
    expect(closed).toBe(true);
  });

  it('reports failed writes and keeps the next edit runnable', async () => {
    const queue = new WriteQueue();
    const errors: (string | null)[] = [];
    const pending: number[] = [];
    queue.subscribe((status) => {
      errors.push(status.error);
      pending.push(status.pending);
    });
    const failure = queue.run(async () => {
      throw new Error('Disk full');
    });
    const success = queue.run(async () => {});
    expect(await failure).toBe(false);
    expect(await success).toBe(true);
    expect(errors).toContain(
      'Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.',
    );
    expect(errors.at(-1)).toBeNull();
    expect(pending).toContain(2);
    expect(pending.at(-1)).toBe(0);
    await queue.close();
  });
});
