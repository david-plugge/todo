<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import AccountSettings from './AccountSettings.svelte';
  import { Collapsible } from 'bits-ui';
  import { Drawer } from 'vaul-svelte';
  import { Check, ChevronDown, ListTodo, Sun, CalendarDays, Menu, X } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import { useLiveQuery } from '@tanstack/svelte-db';
  import type { Account } from '$lib/pocketbase/session';
  import type { Task } from '$lib/domain/models';
  import TaskComposer from './TaskComposer.svelte';
  import TaskRow from './TaskRow.svelte';
  import SortableRows from './SortableRows.svelte';
  import { dragSession, taskDragType } from '$lib/ui/drag';
  import WorkspaceSidebar from './WorkspaceSidebar.svelte';
  import { compareRank } from '$lib/ranking/rank';
  import { today } from '$lib/domain/dates';
  let { account, logout }: { account: Account; logout: () => void } = $props();
  let mobile = $state(false);
  let drawer = $state(false);
  let drawerContent = $state<HTMLElement | null>(null);
  let activeEditor = $state<string | null>(null);
  let completedOpen = $state(true);
  function setEditor(next: string | null) {
    if (activeEditor === next) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('[data-inline-task-title]'))
      focused.blur();
    activeEditor = next;
  }
  $effect(() => {
    void view;
    void settings;
    untrack(() => setEditor(null));
  });

  const settings = $derived(page.url.searchParams.get('view') === 'settings');
  function selectView(next: string) {
    setEditor(null);
    view = next;
    drawer = false;
    if (settings) void goto(resolve('/'), { noScroll: true });
  }
  const dragging = dragSession();
  const store = untrack(() => account.store);
  const tasks = useLiveQuery((q) => q.from({ task: store.tasks }));
  const lists = useLiveQuery((q) => q.from({ list: store.lists }));
  const outbox = useLiveQuery((q) => q.from({ entry: store.outbox }));
  let ready = $state(false),
    busy = $state(false);
  let newList = $state('');
  let view = $state('today'),
    day = $state(today());
  let announcement = $state('');
  let localStatus = $state('Lade lokale Daten …'),
    syncStatus = $state(''),
    syncPhase = $state<'idle' | 'syncing' | 'offline' | 'error' | 'paused'>('idle'),
    error = $state('');
  const all = $derived(tasks.data.filter((task) => task.deletedAt === undefined).sort(compareRank));
  const orderedLists = $derived(
    lists.data.filter((list) => list.deletedAt === undefined).sort(compareRank),
  );

  // Flat bar: no cards, no borders. The active tab is carried by colour alone.
  function navItem(active: boolean) {
    return `flex min-h-[52px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-0 bg-transparent px-0.5 py-1 text-[11px] transition-colors ${active ? 'text-accent' : 'text-muted'}`;
  }

  function focusDrawer(event: Event) {
    event.preventDefault();
    requestAnimationFrame(() => {
      if (!drawer || !drawerContent || drawerContent.contains(document.activeElement)) return;
      // Never open the on-screen keyboard on mount; the close button is a safe landing spot.
      drawerContent.querySelector<HTMLButtonElement>('[aria-label="Menü schließen"]')?.focus();
    });
  }

  const contextualView = $derived(view === 'all' || !['today', 'planned', 'done'].includes(view));
  const openTasks = $derived(
    all.filter(
      (task) =>
        !task.completed &&
        (view === 'all'
          ? true
          : view === 'today'
            ? task.plannedDate === day
            : view === 'planned'
              ? !!task.plannedDate
              : view === 'done'
                ? false
                : task.listId === view),
    ),
  );
  const completedTasks = $derived(
    contextualView
      ? all.filter((task) => task.completed && (view === 'all' || task.listId === view))
      : [],
  );
  const archivedTasks = $derived(view === 'done' ? all.filter((task) => task.completed) : []);
  const primaryTasks = $derived(view === 'done' ? archivedTasks : openTasks);
  const heading = $derived(
    view === 'all'
      ? 'Alle Aufgaben'
      : view === 'today'
        ? 'Mein Tag'
        : view === 'planned'
          ? 'Geplant'
          : view === 'done'
            ? 'Erledigt'
            : (orderedLists.find((list) => list.id === view)?.name ?? 'Liste'),
  );
  const emptyHeading = $derived(
    view === 'done'
      ? 'Hier sammeln sich deine Erfolge.'
      : contextualView && completedTasks.length > 0
        ? 'Keine offenen Aufgaben.'
        : 'Ein frischer Anfang.',
  );
  const emptyDescription = $derived(
    view === 'done'
      ? 'Hier findest du erledigte Aufgaben.'
      : contextualView && completedTasks.length > 0
        ? 'Erledigte Aufgaben findest du weiter unten.'
        : view === 'all'
          ? 'Schreib deine erste Aufgabe auf. Den Rest kannst du später planen.'
          : 'Für diese Ansicht gibt es noch keine Aufgaben.',
  );
  onMount(() => {
    const media = matchMedia('(max-width: 580px)');
    const resize = () => {
      mobile = media.matches;
      if (!mobile) drawer = false;
    };
    resize();
    media.addEventListener('change', resize);
    let active = true;
    store.ready
      .then(() => {
        if (active) {
          ready = true;
          localStatus = 'Lokal bereit';
        }
      })
      .catch(() => {
        if (active) error = 'Lokale Daten konnten nicht geladen werden. Bitte lade die App erneut.';
      });
    const cleanup = account.onStatus((status) => {
      syncStatus = status.message;
      syncPhase = status.phase;
    });
    const stopWrites = account.writes.subscribe((status) => {
      busy = status.pending > 0;
      error = status.error
        ? 'Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.'
        : '';
      if (status.message) localStatus = status.message;
    });
    const timer = setInterval(() => {
      day = today();
    }, 60_000);
    return () => {
      media.removeEventListener('change', resize);
      active = false;
      cleanup();
      stopWrites();
      clearInterval(timer);
    };
  });
  function local(action: () => Promise<unknown>): Promise<boolean> {
    return account.writes.run(action);
  }
  function announce(message: string) {
    announcement = message;
  }
  function assignList(id: string, listId: string) {
    return local(async () => {
      await store.changeTask(id, { listId });
      announcement = 'Aufgabe in die Liste verschoben.';
    });
  }
  function renameList(id: string, name: string) {
    return local(() => store.changeList(id, { name }));
  }
  async function deleteList(id: string, deleteTasks: boolean) {
    const deleted = await local(() => store.deleteList(id, { deleteTasks }));
    if (deleted) {
      if (view === id) view = 'all';
      if (newList === id) newList = '';
      announcement = deleteTasks
        ? 'Liste und ihre Aufgaben gelöscht.'
        : 'Liste gelöscht. Aufgaben bleiben erhalten.';
    }
    return deleted;
  }
</script>

<div
  class="grid min-h-dvh grid-cols-[236px_minmax(0,1fr)] text-sm max-sidebar:grid-cols-[190px_minmax(0,1fr)] max-mobile:block max-mobile:pb-[calc(80px+env(safe-area-inset-bottom))]"
  data-workspace
  use:dragging.controls
>
  {#snippet sidebar()}
    <WorkspaceSidebar
      tasks={all}
      lists={orderedLists}
      {day}
      {ready}
      {busy}
      email={account.email}
      {settings}
      navigate={() => (drawer = false)}
      bind:view={() => view, selectView}
      bind:newList
      create={(name) => local(() => store.createList(name))}
      session={dragging}
      move={(id, before) => local(() => store.moveList(id, before))}
      {assignList}
      rename={renameList}
      remove={deleteList}
      {announce}
    />
  {/snippet}
  {#if mobile}
    <Drawer.Root bind:open={drawer}>
      <nav
        class="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 gap-1 border-t border-border bg-canvas px-2 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))]"
        aria-label="Hauptnavigation"
      >
        <button class={navItem(!settings && view === 'today')} onclick={() => selectView('today')}
          ><Sun size={22} aria-hidden="true" /><span>Mein Tag</span></button
        >
        <button
          class={navItem(!settings && view === 'planned')}
          onclick={() => selectView('planned')}
          ><CalendarDays size={22} aria-hidden="true" /><span>Geplant</span></button
        >
        <button class={navItem(!settings && view === 'all')} onclick={() => selectView('all')}
          ><ListTodo size={22} aria-hidden="true" /><span>Alle Aufgaben</span></button
        >
        <Drawer.Trigger class={navItem(settings || !['today', 'planned', 'all'].includes(view))}
          ><Menu size={22} aria-hidden="true" /><span>Mehr</span></Drawer.Trigger
        >
      </nav>
      <Drawer.Portal>
        <Drawer.Overlay class="fixed inset-0 z-100 bg-overlay" />
        <Drawer.Content
          bind:ref={drawerContent}
          onOpenAutoFocus={focusDrawer}
          class="fixed inset-x-0 bottom-0 z-101 flex max-h-[85dvh] flex-col rounded-t-[20px] bg-surface shadow-drawer outline-none"
          data-workspace
        >
          <Drawer.Handle
            class="mx-auto mt-2.5 mb-1 h-1 w-10 shrink-0 rounded-full bg-border-strong"
          />
          <div
            class="min-h-0 overflow-y-auto overscroll-contain px-4 pt-2 pb-[calc(16px+env(safe-area-inset-bottom))]"
            use:dragging.controls
          >
            <div class="flex items-center justify-between">
              <Drawer.Title class="text-base font-semibold">Deine Aufgaben</Drawer.Title
              ><Drawer.Close
                class="min-h-11 min-w-11 border-0 bg-transparent"
                aria-label="Menü schließen"><X size={20} /></Drawer.Close
              >
            </div>
            <Drawer.Description class="sr-only"
              >Alle Ansichten, deine Listen und Einstellungen.</Drawer.Description
            >
            {@render sidebar()}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  {:else}
    {@render sidebar()}
  {/if}
  <div class="min-w-0" hidden={!settings}>
    <AccountSettings {account} {logout} active={settings}>
      <section class="border-t border-border py-6" aria-label="Synchronisierung">
        <h2 class="m-0 text-[15px] font-semibold">Synchronisierung &amp; lokale Daten</h2>
        {@render syncDetails()}
      </section>
    </AccountSettings>
  </div>
  <section
    class="w-full max-w-[960px] min-w-0 px-8 pt-8 pb-10 max-sidebar:px-5 max-sidebar:pt-7 max-mobile:px-[18px] max-mobile:pt-[26px]"
    aria-label="Aufgaben"
    hidden={settings}
  >
    <div class="mb-4 max-mobile:mb-3.5">
      <div>
        <h1
          class="m-0 text-[28px] leading-[1.3] font-bold tracking-[-0.8px] wrap-anywhere max-mobile:text-[26px]"
        >
          {heading}
        </h1>
      </div>
    </div>
    {#if error}<p role="alert" class="rounded-lg bg-danger-soft p-3 text-[13px] text-danger">
        {error}
      </p>{/if}
    {#if view !== 'done'}
      <p id="sort-help" class="sr-only">
        Aufgabe ziehen; auf Touch kurz halten. Mit Tastatur: Leertaste, Pfeiltasten, dann Leertaste.
        Mit Tab zu einer anderen Liste.
      </p>
    {/if}
    <p class="sr-only" role="status" data-testid="sort-status">{announcement}</p>
    {#snippet taskItem(task: Task)}
      <TaskRow
        {task}
        bind:editing={
          () => activeEditor === task.id,
          (open) => {
            if (open) setEditor(task.id);
            else if (activeEditor === task.id) setEditor(null);
          }
        }
        showList={view !== task.listId}
        lists={orderedLists}
        {day}
        change={(changes) => local(() => store.changeTask(task.id, changes))}
      />
    {/snippet}
    <div data-testid="open-task-group">
      {#if view === 'done'}
        <div class="[&>article+article]:border-t-border" data-testid="done-task-group">
          {#each archivedTasks as task (task.id)}
            {@render taskItem(task)}
          {/each}
        </div>
      {:else}
        <SortableRows
          items={openTasks}
          type={taskDragType}
          label="Offene Aufgaben sortieren"
          itemLabel={(task) => task.title}
          session={dragging}
          move={(id, before) => local(() => store.moveTask(id, before))}
          {announce}
        >
          {#snippet children(task)}
            {@render taskItem(task)}
          {/snippet}
        </SortableRows>
      {/if}
      {#if primaryTasks.length === 0}
        <div class="px-6 py-[42px] text-center text-muted">
          <span class="inline-grid size-[42px] place-items-center rounded-full bg-selected"
            ><Check size={28} aria-hidden="true" /></span
          >
          <h3 class="text-[15px] font-medium text-accent">{emptyHeading}</h3>
          <p class="mx-auto max-w-75 text-xs leading-[1.7]">{emptyDescription}</p>
        </div>
      {/if}
    </div>
    {#if view !== 'done'}
      <TaskComposer
        bind:expanded={
          () => activeEditor === 'new',
          (open) => {
            if (open) setEditor('new');
            else if (activeEditor === 'new') setEditor(null);
          }
        }
        {ready}
        {busy}
        lists={orderedLists}
        defaultDate={view === 'today' ? day : null}
        bind:newList
        create={(title, options) => local(() => store.createTask(title, options))}
      />
    {/if}
    {#if contextualView && completedTasks.length > 0}
      <Collapsible.Root bind:open={completedOpen}>
        <section class="mt-6 border-t border-border pt-2" aria-label="Erledigte Aufgaben">
          <Collapsible.Trigger
            class="flex min-h-9 w-full cursor-pointer items-center justify-between rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-xs font-medium text-muted hover:bg-selected"
          >
            <span>Erledigt ({completedTasks.length})</span>
            <ChevronDown
              class={`transition-transform duration-150 ${completedOpen ? 'rotate-180' : ''}`}
              size={16}
              aria-hidden="true"
            />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="[&>article+article]:border-t-border" data-testid="completed-task-group">
              {#each completedTasks as task (task.id)}
                {@render taskItem(task)}
              {/each}
            </div>
          </Collapsible.Content>
        </section>
      </Collapsible.Root>
    {/if}
  </section>
</div>
{#snippet syncDetails()}
  <div
    class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 text-xs text-muted"
  >
    <div class="flex min-w-0 items-center gap-2">
      <span
        class={`size-2 shrink-0 rounded-full ${syncPhase === 'error' ? 'bg-danger' : syncPhase === 'offline' || outbox.data.length > 0 ? 'bg-warning' : 'bg-success'}`}
        aria-hidden="true"
      ></span><span data-testid="account-sync-status">{syncStatus}</span>
    </div>
    <button
      class="min-h-9 cursor-pointer rounded-md border border-border bg-canvas px-3 py-2 text-xs text-accent hover:bg-selected disabled:cursor-default disabled:opacity-40"
      disabled={!ready || syncPhase === 'syncing'}
      onclick={() => account.engine.trigger()}>Jetzt synchronisieren</button
    >
  </div>
  <div class="mt-2 text-xs text-muted">
    <p class="sr-only" data-testid="account-local-status">{localStatus}</p>
    <p class:sr-only={outbox.data.length === 0}>
      {outbox.data.length === 1 ? 'Eine Änderung wartet' : 'Wartende Änderungen'}:
      <strong data-testid="account-pending">{outbox.data.length}</strong>
    </p>
  </div>
{/snippet}
