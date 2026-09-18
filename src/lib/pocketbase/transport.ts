import type PocketBase from 'pocketbase';
import type { PushTransport } from '../sync/push';
import type { PullTransport } from '../sync/pull';

export function pocketBaseTransport(
  pb: PocketBase,
  ownerId: string,
): PushTransport & PullTransport {
  function checkOwner() {
    if (pb.authStore.record?.id !== ownerId) throw new Error('Account changed; old sync stopped');
  }
  return {
    async send(mutation, generation, signal) {
      checkOwner();
      return pb.send('/api/todo/push', {
        method: 'POST',
        body: mutation,
        headers: { 'X-Todo-Sync-Generation': generation },
        signal,
        requestKey: null,
      });
    },
    async fetchPage(after, until, limit, signal, generation) {
      checkOwner();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      return pb.send('/api/todo/pull', {
        query: { after, until, limit, generation },
        signal: bounded,
        requestKey: null,
      });
    },
    async fetchSnapshotPage(generation, until, kind, after, limit, signal) {
      checkOwner();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      return pb.send('/api/todo/snapshot', {
        query: { generation, until, kind, after, limit },
        signal: bounded,
        requestKey: null,
      });
    },
  };
}
