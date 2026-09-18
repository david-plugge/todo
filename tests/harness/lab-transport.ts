import type { PushTransport } from '../../src/lib/sync/push';

/** Test harness only: the production application never uses this transport. */
export function createLabTransport(): PushTransport {
  const key = 'todo-sync-lab-session';
  let session = localStorage.getItem(key);
  if (!session) {
    session = crypto.randomUUID();
    localStorage.setItem(key, session);
  }
  return {
    async send(mutation, signal) {
      const response = await fetch('/api/spike/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-spike-session': session },
        body: JSON.stringify(mutation),
        signal,
      });
      if (!response.ok) throw new Error(`Testserver: HTTP ${response.status}`);
      return response.json();
    },
  };
}
