<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { completeOIDCSignIn } from '$lib/pocketbase/sign-in';
  let error = $state('');
  onMount(() => {
    void completeOIDCSignIn(new URL(location.href))
      .then((returnTo) => location.replace(returnTo))
      .catch(() => {
        error = 'Anmeldung fehlgeschlagen oder abgelaufen. Bitte erneut anmelden.';
      });
  });
</script>

<svelte:head
  ><title>Anmelden · Todo</title><meta name="referrer" content="no-referrer" /></svelte:head
>
<main class="mx-auto my-[8vh] max-w-120 p-6">
  {#if error}
    <p class="text-danger" role="alert">{error}</p>
    <a href={resolve('/')} class="text-inherit">Zur Anmeldung</a>
  {:else}
    <p class="text-sm text-muted" role="status">Anmeldung wird abgeschlossen …</p>
  {/if}
</main>
