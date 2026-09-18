<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ArrowLeft, UserRound } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import type { Account } from '$lib/pocketbase/session';
  import ConnectedAgents from './ConnectedAgents.svelte';
  let {
    account,
    logout,
    active,
    children,
  }: { account: Account; logout: () => void; active: boolean; children: Snippet } = $props();
</script>

<section
  class="w-full max-w-[800px] min-w-0 px-8 pt-8 pb-10 max-sidebar:px-5 max-sidebar:pt-7 max-mobile:px-[18px] max-mobile:pt-[26px]"
  aria-label="Einstellungen"
>
  <a
    class="mb-[26px] inline-flex items-center gap-2 text-xs text-muted no-underline"
    href={resolve('/')}><ArrowLeft size={16} /> Zurück zu Aufgaben</a
  >
  <div class="mb-4 max-mobile:mb-3.5">
    <p class="mb-2.5 text-[10px] font-semibold tracking-[0.06em] text-muted">DEIN FREIRAUM</p>
    <h1
      class="m-0 text-[28px] leading-[1.3] font-bold tracking-[-0.8px] wrap-anywhere max-mobile:text-[26px]"
    >
      Einstellungen
    </h1>
    <p class="mt-1 text-xs text-muted">Dein Konto und die Apps, die darauf zugreifen dürfen.</p>
  </div>
  <section class="border-t border-border py-6" aria-labelledby="account-heading">
    <h2 class="m-0 flex items-center gap-2.25 text-[15px] font-semibold" id="account-heading">
      <UserRound size={18} aria-hidden="true" /> Dein Account
    </h2>
    <dl class="my-6 grid grid-cols-[85px_minmax(0,1fr)] gap-3 text-[13px]">
      <dt class="text-muted">E-Mail</dt>
      <dd class="m-0 wrap-anywhere">{account.email}</dd>
      <dt class="text-muted">Konto-ID</dt>
      <dd class="m-0 font-mono wrap-anywhere">{account.ownerId}</dd>
    </dl>
    <p class="text-[13px] leading-[1.7] text-muted">
      Deine Aufgaben bleiben auf diesem Gerät verfügbar, auch wenn du offline bist.
    </p>
    <button
      class="min-h-9 cursor-pointer rounded-md border border-border bg-surface px-3 py-2 text-xs text-accent transition-colors hover:bg-[#edf0e7]"
      onclick={logout}
      aria-label="Abmelden">Auf diesem Gerät abmelden</button
    >
  </section>
  {@render children()}
  {#if active}<ConnectedAgents />{/if}
</section>
