<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { AccountSession, type Account } from '$lib/pocketbase/session';
  import AccountTodo from '$lib/components/AccountTodo.svelte';
  const session = new AccountSession();
  let account = $state<Account | null>(null);
  let sessionReady = $state(!session.hasCachedIdentity());
  let email = $state(''),
    password = $state(''),
    error = $state(''),
    busy = $state(false);
  onMount(() => {
    session.start(
      (value) => {
        account = value;
      },
      () => {
        sessionReady = true;
      },
    );
    return () => {
      void session.close();
    };
  });
  async function login() {
    busy = true;
    error = '';
    try {
      await session.login(email, password);
      password = '';
    } catch {
      error = 'Anmeldung fehlgeschlagen. Zugangsdaten und Verbindung prüfen.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head
  ><title
    >{account && page.url.searchParams.get('view') === 'settings'
      ? 'Einstellungen · Todo'
      : 'Todo · Deine Aufgaben'}</title
  ></svelte:head
>
<main class="m-0 p-0">
  {#if account}
    {#key account.ownerId}<AccountTodo {account} logout={() => session.logout()} />{/key}
  {:else if !sessionReady}
    <section class="grid min-h-dvh place-items-center px-[18px] text-sm text-muted" role="status">
      Deine Aufgaben werden geladen …
    </section>
  {:else}
    <section class="mx-auto mt-[70px] mb-[85px] max-w-[390px] px-[18px] max-mobile:my-[45px]">
      <p class="text-[10px] tracking-[1.7px] text-muted">DEIN TAG, EIN BISSCHEN LEICHTER</p>
      <h1 class="my-5 text-[40px] leading-[1.15] font-[550] tracking-[-1.5px]">
        Raum für das,<br />was wichtig ist.
      </h1>
      <p class="mb-[30px] text-sm leading-[1.7] text-muted">
        Aufgaben sammeln, in Ruhe planen und Schritt für Schritt erledigen.
      </p>
      <form
        class="grid gap-[17px]"
        onsubmit={(event) => {
          event.preventDefault();
          void login();
        }}
      >
        <label class="grid gap-2 text-xs text-muted"
          >E-Mail<input
            class="w-full rounded-lg border border-border bg-surface p-3 text-text"
            type="email"
            autocomplete="username"
            bind:value={email}
            required
          /></label
        ><label class="grid gap-2 text-xs text-muted"
          >Passwort<input
            class="w-full rounded-lg border border-border bg-surface p-3 text-text"
            type="password"
            autocomplete="current-password"
            bind:value={password}
            required
          /></label
        ><button
          class="mt-1 cursor-pointer rounded-[7px] border-0 bg-accent p-[13px] text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:opacity-40"
          disabled={busy}>{busy ? 'Anmelden …' : 'Anmelden'}</button
        >
      </form>
      {#if error}<p role="alert" class="text-[13px] text-danger">{error}</p>{/if}
      <p class="mt-[25px] text-[11px] leading-[1.8] text-muted">
        Für die erste Anmeldung brauchst du eine Verbindung.<br />Danach bleiben deine Aufgaben auch
        offline verfügbar.
      </p>
    </section>
  {/if}
</main>
