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
    async send(mutation, signal) {
      checkOwner();
      return pb.send('/api/todo/push', {
        method: 'POST',
        body: mutation,
        signal,
        requestKey: null,
      });
    },
    async fetchPage(after, until, limit, signal) {
      checkOwner();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      return pb.send('/api/todo/pull', {
        query: { after, until, limit },
        signal: bounded,
        requestKey: null,
      });
    },
  };
}
