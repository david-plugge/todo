<script lang="ts">
  import { onMount } from 'svelte';
  import { Bot } from '@lucide/svelte';
  import PocketBase, { LocalAuthStore } from 'pocketbase';
  const pb = new PocketBase(location.origin, new LocalAuthStore('todo-auth-v1'));
  let items = $state<{ id: string; name: string; scope: string }[]>([]);
  let loaded = $state(false),
    busy = $state(false),
    error = $state('');
  onMount(() => {
    void load();
  });
  async function load() {
    busy = true;
    error = '';
    try {
      items = (await pb.send('/api/oauth/connections', {})).items;
      loaded = true;
    } catch {
      error = 'Verbindungen konnten nicht geladen werden. Bitte online erneut versuchen.';
    } finally {
      busy = false;
    }
  }
  async function revoke(id: string) {
    busy = true;
    error = '';
    try {
      await pb.send(`/api/oauth/connections/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
      items = items.filter((item) => item.id !== id);
    } catch {
      error = 'Widerruf fehlgeschlagen. Bitte erneut versuchen.';
    } finally {
      busy = false;
    }
  }
  function scopeLabel(scope: string) {
    const scopes = new Set(scope.split(' '));
    const read = scopes.has('tasks:read');
    const write = scopes.has('tasks:write');
    if (read && write) return 'Aufgaben lesen und bearbeiten';
    if (write) return 'Aufgaben erstellen und bearbeiten';
    if (read) return 'Aufgaben lesen';
    return 'Kein Zugriff auf Aufgaben';
  }
</script>

<section
  class="my-6 border-t border-border py-6 text-[13px] text-muted"
  aria-labelledby="agents-heading"
>
  <h2 class="flex items-center gap-2.25 text-[15px] font-semibold text-text" id="agents-heading">
    <Bot size={18} aria-hidden="true" /> Verbundene Agenten
  </h2>
  <p class="leading-[1.6]">Hier kannst du den Zugriff eines Agenten auf dein Konto beenden.</p>
  <button
    class="cursor-pointer rounded-lg border border-border bg-white px-3 py-2.5 text-text disabled:opacity-50"
    disabled={busy}
    onclick={load}>{loaded ? 'Aktualisieren' : 'Verbindungen laden'}</button
  >
  {#each items as item (item.id)}
    <div class="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <span><strong class="wrap-anywhere">{item.name}</strong><br />{scopeLabel(item.scope)}</span
      ><button
        class="cursor-pointer rounded-lg border border-border bg-white px-3 py-2.5 text-text disabled:opacity-50"
        disabled={busy}
        onclick={() => revoke(item.id)}>Zugriff widerrufen</button
      >
    </div>
  {:else}{#if loaded}<p class="leading-[1.6]">Keine aktiven Verbindungen.</p>{/if}{/each}
  {#if error}<p class="leading-[1.6] text-danger" role="alert">{error}</p>{/if}
</section>
