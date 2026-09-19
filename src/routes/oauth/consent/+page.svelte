<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import PocketBase, { LocalAuthStore } from 'pocketbase';
  const pb = new PocketBase(location.origin, new LocalAuthStore('todo-auth-v1'));
  let details = $state<{ clientName: string; redirectOrigin: string; scope: string } | null>(null);
  let email = $state(''),
    password = $state(''),
    signedIn = $state(pb.authStore.isValid);
  let busy = $state(false),
    error = $state('');
  const request = new URL(location.href).searchParams.get('request') ?? '';
  onMount(() => {
    void pb
      .send('/api/oauth/consent', { query: { request } })
      .then((value) => {
        details = value;
      })
      .catch(() => {
        error =
          'Diese Anfrage ist abgelaufen oder ungültig. Bitte die Verbindung im Agenten neu starten.';
      });
  });
  async function login() {
    busy = true;
    error = '';
    try {
      await pb.collection('todo_users').authWithPassword(email, password);
      signedIn = true;
      password = '';
    } catch {
      error = 'Anmeldung fehlgeschlagen. Zugangsdaten und Verbindung prüfen.';
    } finally {
      busy = false;
    }
  }
  async function decide(approve: boolean) {
    busy = true;
    error = '';
    try {
      const result = await pb.send('/api/oauth/consent', {
        method: 'POST',
        body: { request, approve },
      });
      // Redirect is produced from the server-validated OAuth client's exact registered URI.
      window.location.assign(result.redirect);
    } catch {
      error = 'Freigabe fehlgeschlagen oder Anfrage abgelaufen. Bitte erneut verbinden.';
      busy = false;
    }
  }
</script>

<svelte:head
  ><title>Agent verbinden · Todo</title><meta name="referrer" content="no-referrer" /></svelte:head
>
<main class="mx-auto my-[8vh] max-w-120 p-6">
  <a href={resolve('/')} class="text-2xl font-bold text-inherit no-underline">todo.</a>
  <h1 class="mt-9 text-2xl font-bold">Agent verbinden</h1>
  {#if details}
    <p class="leading-[1.6]">
      <strong>{details.clientName}</strong> möchte auf dein Todo-Konto zugreifen.
    </p>
    <p class="text-sm leading-[1.6] wrap-anywhere text-muted">
      Rückleitung an <strong>{details.redirectOrigin}</strong>
    </p>
    <ul class="list-disc pl-10">
      {#if details.scope.split(' ').includes('tasks:read')}<li class="mb-2 leading-[1.6]">
          Deine Aufgaben und Listen lesen
        </li>{/if}
      {#if details.scope.split(' ').includes('tasks:write')}<li class="mb-2 leading-[1.6]">
          Deine Aufgaben erstellen, ändern, erledigen und löschen; Listen erstellen
        </li>{/if}
    </ul>
    <p class="leading-[1.6]">
      Der Zugriff gilt nur für dein Konto. Du kannst die Verbindung später widerrufen.
    </p>
    {#if signedIn}
      <p class="leading-[1.6]">Angemeldet als <strong>{pb.authStore.record?.email}</strong></p>
      <div class="mt-6 flex gap-3">
        <button
          class="cursor-pointer rounded-lg border border-border bg-white p-3 disabled:opacity-50"
          disabled={busy}
          onclick={() => decide(false)}>Ablehnen</button
        ><button
          class="cursor-pointer rounded-lg border border-border bg-accent p-3 text-white disabled:opacity-50"
          disabled={busy}
          onclick={() => decide(true)}>Zugriff erlauben</button
        >
      </div>
    {:else}
      <form
        class="mt-6 grid gap-[18px]"
        onsubmit={(event) => {
          event.preventDefault();
          void login();
        }}
      >
        <label class="grid gap-2.5"
          >E-Mail<input
            class="rounded-lg border border-border bg-white p-3"
            type="email"
            autocomplete="username"
            bind:value={email}
            required
          /></label
        >
        <label class="grid gap-2.5"
          >Passwort<input
            class="rounded-lg border border-border bg-white p-3"
            type="password"
            autocomplete="current-password"
            bind:value={password}
            required
          /></label
        >
        <button
          class="cursor-pointer rounded-lg border border-border bg-accent p-3 text-white disabled:opacity-50"
          disabled={busy}>Anmelden</button
        >
      </form>
    {/if}
  {:else if !error}<p class="leading-[1.6]">Verbindungsanfrage wird geladen …</p>{/if}
  {#if error}<p class="text-danger" role="alert">{error}</p>{/if}
</main>
