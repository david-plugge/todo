<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount, untrack } from 'svelte';
  import { useLiveQuery } from '@tanstack/svelte-db';
  import { createStore } from '../../src/lib/db/store';
  import { PushWorker } from '../../src/lib/sync/push';
  import { createLabTransport } from './lab-transport';

  const { syncLab = false }: { syncLab?: boolean } = $props();
  // A route instance owns one fixed database for its entire lifetime.
  const store = untrack(() => createStore(syncLab ? 'todo-sync-lab-v1' : undefined));
  const worker = untrack(() =>
    syncLab ? new PushWorker(store.adapter, createLabTransport()) : undefined,
  );
  let pushing = $state(false);
  let syncStatus = $state('Bereit für manuellen Test-Push');

  async function push() {
    pushing = true;
    try {
      await store.ready;
      const count = await worker!.push();
      syncStatus = `${count} ACK(s) bestätigt`;
    } catch (error) {
      syncStatus = `Push fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      pushing = false;
    }
  }
  const tasks = useLiveQuery((q) =>
    q.from({ task: store.tasks }).orderBy(({ task }) => task.createdAt, 'asc'),
  );
  const outbox = useLiveQuery((q) =>
    q.from({ entry: store.outbox }).orderBy(({ entry }) => entry.createdAt, 'asc'),
  );
  let title = $state('');
  let status = $state('IndexedDB wird geladen …');
  let ready = $state(false);
  let busy = $state(false);
  let fail = $state(false);
  let online = $state(true);

  onMount(() => {
    store.ready
      .then(() => {
        ready = true;
        status = 'Lokal bereit';
      })
      .catch((error) => {
        status = `Fehler: ${error.message}`;
      });
    const update = () => {
      online = navigator.onLine;
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      worker?.cancel();
      void store.close();
    };
  });

  async function run(action: () => Promise<unknown>) {
    busy = true;
    const rejectOutbox = () => {
      throw new Error('Absichtlicher Fehler beim zweiten Write (outbox)');
    };
    if (fail) store.db.outbox.hook('creating', rejectOutbox);
    try {
      await action();
      status = 'Lokal atomar gespeichert';
    } catch (error) {
      status = `Rollback: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      store.db.outbox.hook('creating').unsubscribe(rejectOutbox);
      busy = false;
    }
  }
</script>

<svelte:head
  ><title>Test-Harness · Local-first Todo</title><meta
    name="description"
    content="Interne Browser-Testoberfläche für atomare lokale Änderungen"
  /></svelte:head
>
<main
  class="relative z-0 mx-auto my-16 max-w-200 px-6 text-[#173b35] before:fixed before:inset-0 before:-z-1 before:bg-[#f4f5ef] before:content-['']"
>
  <p class="text-xs font-bold tracking-[0.15em]">INTERNES TEST-HARNESS</p>
  <h1 class="my-3 text-4xl font-bold">Local-first Todo</h1>
  <p>TanStack DB → Dexie → IndexedDB. Jeder Task-Write speichert seine Outbox atomar.</p>
  <aside class="my-6 rounded-md bg-[#e5eadf] p-3.5">
    <strong>{online ? 'Browser online' : 'Browser offline'}</strong> · {syncLab
      ? 'Isoliertes Sync-Labor · Testserver, kein PocketBase'
      : 'Lokale Testdatenbank'}
  </aside>
  {#if syncLab}
    <p>
      Eigene Testdatenbank. Der Testserver bestätigt gespeicherte Snapshots; sein Remote-Zustand ist
      flüchtig.
    </p>
    <div class="flex gap-2">
      <button
        class="cursor-pointer rounded-[5px] border-0 bg-[#173b35] px-4 py-2.5 text-white disabled:cursor-wait disabled:opacity-50"
        disabled={!ready || pushing}
        onclick={push}>Test-Push</button
      ><button
        class="cursor-pointer rounded-[5px] border-0 bg-[#e8ede5] px-4 py-2.5 text-[#173b35] disabled:cursor-wait disabled:opacity-50"
        disabled={!pushing}
        onclick={() => worker?.cancel()}>Push abbrechen</button
      >
    </div>
    <p class="min-h-6 text-sm" data-testid="sync-status">{pushing ? 'Push läuft …' : syncStatus}</p>
    <a href={resolve('/')}>Zur normalen Testdatenbank</a>
  {:else}
    <a href={resolve('/sync-lab')}>Isoliertes Sync-Labor öffnen</a>
  {/if}
  <form
    class="mt-4"
    onsubmit={(event) => {
      event.preventDefault();
      const value = title.trim();
      if (value)
        void run(async () => {
          await store.createTask(value);
          title = '';
        });
    }}
  >
    <label class="mb-2 block font-semibold" for="title">Neuer Task</label>
    <div class="flex gap-2">
      <input
        class="min-w-0 flex-1 rounded-[5px] border border-[#a7b5a7] p-3"
        id="title"
        bind:value={title}
        placeholder="Atomicity verifizieren"
        required
      /><button
        class="cursor-pointer rounded-[5px] border-0 bg-[#173b35] px-4 py-2.5 text-white disabled:cursor-wait disabled:opacity-50"
        disabled={!ready || busy}>Erstellen</button
      >
    </div>
  </form>
  <label class="mt-[18px] block text-sm"
    ><input type="checkbox" bind:checked={fail} disabled={busy} /> Outbox-Write absichtlich fehlschlagen
    lassen</label
  >
  <p class="min-h-6 text-sm" role="status">{status}</p>
  <section class="mt-7 border-t border-[#c9d2c6] pt-2">
    <h2 class="text-xl font-bold">
      Tasks <small class="ml-2 text-sm">{tasks.data.filter((task) => !task.deletedAt).length}</small
      >
    </h2>
    {#each tasks.data.filter((task) => !task.deletedAt) as task (task.id)}
      <article class="my-2 flex items-center gap-3 rounded-[5px] bg-white p-3" data-testid="task">
        <label class="flex flex-1 items-center gap-2.5"
          ><input
            type="checkbox"
            checked={task.completed}
            disabled={busy}
            onchange={() => run(() => store.changeTask(task.id, { completed: !task.completed }))}
          /><span class:line-through={task.completed}>{task.title}</span></label
        ><span class="text-sm text-[#56685f]">v{task.version}</span><button
          class="cursor-pointer rounded-[5px] border-0 bg-[#e8ede5] px-4 py-2.5 text-[#173b35] disabled:cursor-wait disabled:opacity-50"
          disabled={busy}
          onclick={() => run(() => store.changeTask(task.id, { deletedAt: Date.now() }))}
          >Löschen</button
        >
      </article>
    {:else}<p class="text-sm text-[#56685f]">Noch keine aktiven Tasks.</p>{/each}
  </section>
  <section class="mt-7 border-t border-[#c9d2c6] pt-2">
    <h2 class="text-xl font-bold">
      Persistente Outbox <small class="ml-2 text-sm" data-testid="outbox-count"
        >{outbox.data.length}</small
      >
    </h2>
    <p class="text-sm text-[#56685f]">
      {syncLab
        ? 'ACKs entfernen nur die bestätigte Mutation. Neue Änderungen bleiben pending.'
        : 'Ohne Backend bleiben Einträge pending.'} Löschen erzeugt einen Tombstone.
    </p>
    {#each outbox.data as entry (entry.id)}<div
        class="flex gap-4 py-2 text-[13px]"
        data-testid="outbox-entry"
      >
        <code class="w-14">{entry.operation}</code><span>{entry.entityId.slice(0, 8)}</span><span
          >v{entry.entityVersion}</span
        ><span>pending · Versuch {entry.retryCount}</span>
      </div>{/each}
  </section>
  <footer class="mt-10 text-[13px] leading-[1.6] text-[#56685f]">
    Diese Oberfläche wird ausschließlich in Playwright gebaut und ausgeliefert.
  </footer>
</main>
