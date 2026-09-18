<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { ListTodo, Sun, CalendarDays, Check, Plus, UserRound } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import type { Task, TaskList } from '$lib/domain/models';
  import SortableRows from './SortableRows.svelte';
  import WorkspaceListRow from './WorkspaceListRow.svelte';
  import type { DragSession } from '$lib/ui/drag';
  let {
    email,
    settings,
    navigate = () => {},
    tasks: all,
    lists: orderedLists,
    day,
    ready,
    busy,
    view = $bindable('all'),
    newList = $bindable(''),
    create,
    session,
    move,
    assignList,
    rename,
    remove,
    announce,
  }: {
    email: string;
    settings: boolean;
    navigate?: () => void;
    tasks: Task[];
    lists: TaskList[];
    day: string;
    ready: boolean;
    busy: boolean;
    view?: string;
    newList?: string;
    create: (name: string) => Promise<boolean>;
    session: DragSession;
    move: (id: string, before: string | null) => Promise<boolean>;
    assignList: (id: string, listId: string) => Promise<boolean>;
    rename: (id: string, name: string) => Promise<boolean>;
    remove: (id: string, deleteTasks: boolean) => Promise<boolean>;
    announce: (message: string) => void;
  } = $props();
  let listName = $state('');
  let dialogOpen = $state(false);
  let selectedList = $state<TaskList | null>(null);
  let dialogError = $state('');
  let deleteTasks = $state(false);
  const plannedCount = $derived(all.filter((task) => !!task.plannedDate && !task.completed).length);
  const completedCount = $derived(all.filter((task) => task.completed).length);
  async function submit() {
    const draft = listName;
    if ((await create(draft.trim())) && listName === draft) listName = '';
  }
  function openDeleteDialog(list: TaskList) {
    selectedList = list;
    dialogError = '';
    deleteTasks = false;
    dialogOpen = true;
  }
  async function submitDialog() {
    if (!selectedList) return;
    const success = await remove(selectedList.id, deleteTasks);
    if (success) dialogOpen = false;
    else dialogError = 'Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.';
  }
</script>

<aside
  class="sticky top-0 flex h-dvh flex-col overflow-y-auto border-r border-border px-3 pt-3.5 pb-3 max-mobile:static max-mobile:h-auto max-mobile:overflow-visible max-mobile:border-0 max-mobile:px-0 max-mobile:pt-2 max-mobile:pb-0"
  aria-label="Aufgabenansichten"
>
  <a
    class="mx-1 mb-[22px] flex shrink-0 items-center gap-2.25 text-[23px] font-bold tracking-[-1px] text-[#314e33] no-underline max-mobile:hidden"
    onclick={navigate}
    href={resolve('/')}
    aria-label="Freiraum"
  >
    <span class="grid size-[30px] place-items-center rounded-[9px] bg-accent text-white"
      ><Check size={21} aria-hidden="true" /></span
    >
    <span>freiraum<span class="text-[#9bad70]">.</span></span>
  </a>
  <nav class="grid gap-0.5 max-mobile:grid-cols-2" aria-label="Ansichten">
    <button
      class="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2.25 rounded-md border-0 bg-transparent px-2.5 py-2.25 text-left text-[13px] text-text hover:bg-[#edf0e7] max-mobile:min-h-11"
      class:bg-selected={!settings && view === 'today'}
      class:text-accent={!settings && view === 'today'}
      aria-current={!settings && view === 'today' ? 'page' : undefined}
      onclick={() => {
        view = 'today';
      }}
      ><span class="flex min-w-0 flex-1 items-center gap-2.5"
        ><Sun class="shrink-0" size={18} aria-hidden="true" /><span class="truncate">Mein Tag</span
        ></span
      ><span class="shrink-0 text-[11px] text-muted tabular-nums"
        >{all.filter((t) => t.plannedDate === day && !t.completed).length}</span
      ></button
    >
    <button
      class="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2.25 rounded-md border-0 bg-transparent px-2.5 py-2.25 text-left text-[13px] text-text hover:bg-[#edf0e7] max-mobile:min-h-11"
      class:bg-selected={!settings && view === 'planned'}
      class:text-accent={!settings && view === 'planned'}
      aria-current={!settings && view === 'planned' ? 'page' : undefined}
      onclick={() => {
        view = 'planned';
      }}
      ><span class="flex min-w-0 flex-1 items-center gap-2.5"
        ><CalendarDays class="shrink-0" size={18} aria-hidden="true" /><span class="truncate"
          >Geplant</span
        ></span
      ><span class="shrink-0 text-[11px] text-muted tabular-nums">{plannedCount}</span></button
    >
    <button
      class="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2.25 rounded-md border-0 bg-transparent px-2.5 py-2.25 text-left text-[13px] text-text hover:bg-[#edf0e7] max-mobile:min-h-11"
      class:bg-selected={!settings && view === 'all'}
      class:text-accent={!settings && view === 'all'}
      aria-current={!settings && view === 'all' ? 'page' : undefined}
      onclick={() => {
        view = 'all';
      }}
      ><span class="flex min-w-0 flex-1 items-center gap-2.5"
        ><ListTodo class="shrink-0" size={18} aria-hidden="true" /><span class="truncate"
          >Alle Aufgaben</span
        ></span
      ><span class="shrink-0 text-[11px] text-muted tabular-nums">{all.length}</span></button
    >
    <button
      class="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2.25 rounded-md border-0 bg-transparent px-2.5 py-2.25 text-left text-[13px] text-text hover:bg-[#edf0e7] max-mobile:min-h-11"
      class:bg-selected={!settings && view === 'done'}
      class:text-accent={!settings && view === 'done'}
      aria-current={!settings && view === 'done' ? 'page' : undefined}
      onclick={() => {
        view = 'done';
      }}
      ><span class="flex min-w-0 flex-1 items-center gap-2.5"
        ><Check class="shrink-0" size={18} aria-hidden="true" /><span class="truncate"
          >Erledigt</span
        ></span
      ><span class="shrink-0 text-[11px] text-muted tabular-nums">{completedCount}</span></button
    >
  </nav>
  <div
    class="mx-2.5 mt-[30px] mb-2.5 flex justify-between text-[11px] font-semibold tracking-[0.06em] text-muted max-mobile:mt-[18px] max-mobile:mb-2"
  >
    MEINE LISTEN <span>{orderedLists.length}</span>
  </div>
  <div class="m-0 p-0">
    <SortableRows
      items={orderedLists}
      type="freiraum-list"
      label="Listen"
      itemLabel={(list) => list.name}
      {session}
      {move}
      {announce}
    >
      {#snippet children(list)}
        <WorkspaceListRow
          {list}
          count={all.filter((task) => task.listId === list.id && !task.completed).length}
          active={view === list.id}
          {settings}
          {busy}
          {session}
          select={() => {
            view = list.id;
            newList = list.id;
          }}
          {rename}
          remove={openDeleteDialog}
          assign={(id) => assignList(id, list.id)}
          {announce}
        />
      {/snippet}
    </SortableRows>
  </div>
  <form
    class="mx-1 my-2.5 flex gap-1 max-mobile:mb-0 max-mobile:max-w-[250px]"
    onsubmit={(event) => {
      event.preventDefault();
      if (ready && listName.trim()) void submit();
    }}
  >
    <input
      class="w-full min-w-0 rounded-md border border-transparent bg-transparent p-2 text-base text-text focus:border-border focus:shadow-none"
      disabled={!ready}
      aria-label="Neue Liste"
      placeholder="Neue Liste …"
      enterkeyhint="done"
      bind:value={listName}
      maxlength="2000"
      required
    />
    <button
      class="grid size-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-accent hover:bg-selected disabled:cursor-default disabled:opacity-40"
      type="submit"
      aria-label="Liste hinzufügen"
      title="Liste hinzufügen"
      disabled={!ready || busy || !listName.trim()}
    >
      <Plus size={18} aria-hidden="true" />
    </button>
  </form>
  <div
    class="mt-auto flex items-center gap-1 pt-6 max-mobile:mt-3 max-mobile:border-t max-mobile:border-border max-mobile:pt-4"
  >
    <a
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-text no-underline hover:bg-selected max-mobile:p-2"
      class:bg-selected={settings}
      href={resolve('/?view=settings')}
      onclick={navigate}
      aria-label="Einstellungen"
      title={email}
    >
      <span
        class="grid size-[30px] shrink-0 place-items-center rounded-full bg-selected text-accent"
        ><UserRound size={18} aria-hidden="true" /></span
      >
      <span class="grid min-w-0 gap-0.75"
        ><strong class="text-xs font-semibold">Mein Account</strong><span
          class="truncate text-[10px] text-muted">{email}</span
        ></span
      >
    </a>
  </div>
  <Dialog.Root bind:open={dialogOpen}>
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-130 bg-[#19221b66]" />
      <Dialog.Content
        class="fixed top-1/2 left-1/2 z-131 w-[min(400px,calc(100vw-32px))] -translate-1/2 rounded-[10px] border border-border bg-canvas p-[22px] shadow-[0_16px_48px_#19221b33]"
      >
        <Dialog.Title class="m-0 text-[21px] leading-[1.2] font-bold text-accent"
          >Liste löschen</Dialog.Title
        >
        <Dialog.Description
          class="mt-3 block text-[13px] leading-normal wrap-anywhere text-muted [&_strong]:wrap-anywhere [&_strong]:text-text"
        >
          Die Liste <strong>{selectedList?.name}</strong> wird gelöscht.
          {#if deleteTasks}
            Alle Aufgaben darin werden ebenfalls gelöscht.
          {:else}
            Die Aufgaben bleiben erhalten und werden keiner Liste mehr zugeordnet.
          {/if}
        </Dialog.Description>
        <label
          class="mt-4 flex cursor-pointer items-start gap-2 text-[13px] leading-[1.4] text-text"
          ><input
            class="mt-0.5 w-auto shrink-0 p-0 accent-danger"
            type="checkbox"
            bind:checked={deleteTasks}
            disabled={busy}
          /> Aufgaben in dieser Liste ebenfalls löschen</label
        >
        <div class="mt-5 flex justify-end gap-2">
          <Dialog.Close
            class="min-h-9 cursor-pointer rounded-md border border-border bg-surface px-3 py-2 text-xs text-accent disabled:cursor-default disabled:opacity-40"
            >Abbrechen</Dialog.Close
          >
          <button
            class="min-h-9 cursor-pointer rounded-md border border-danger bg-danger px-3 py-2 text-xs text-white disabled:cursor-default disabled:opacity-40"
            disabled={busy}
            onclick={() => void submitDialog()}>Liste löschen</button
          >
        </div>
        {#if dialogError}<p class="mb-0 text-danger" role="alert">{dialogError}</p>{/if}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
</aside>
