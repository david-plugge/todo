<script lang="ts">
  import { tick } from 'svelte';
  import { Hash } from '@lucide/svelte';
  import type { TaskList } from '$lib/domain/models';
  import type { DragSession } from '$lib/ui/drag';
  import ListActionsMenu from './ListActionsMenu.svelte';
  import ListDropTarget from './ListDropTarget.svelte';

  let {
    list,
    count,
    active,
    settings,
    busy,
    session,
    select,
    rename,
    remove,
    assign,
    announce,
  }: {
    list: TaskList;
    count: number;
    active: boolean;
    settings: boolean;
    busy: boolean;
    session: DragSession;
    select: () => void;
    rename: (id: string, name: string) => Promise<boolean>;
    remove: (list: TaskList) => void;
    assign: (id: string) => Promise<boolean>;
    announce: (message: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let base = $state('');
  let input = $state<HTMLInputElement>();
  let saving = $state(false);

  function stopRowInteraction(event: Event) {
    event.stopPropagation();
  }

  async function startRename() {
    base = list.name;
    draft = list.name;
    editing = true;
    await tick();
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }

  function cancelRename() {
    draft = base;
    editing = false;
  }

  async function saveRename() {
    const next = draft.trim();
    if (!editing || saving) return;
    if (!next) {
      announce('Listenname darf nicht leer sein.');
      cancelRename();
      return;
    }
    if (next === base) {
      editing = false;
      return;
    }
    saving = true;
    try {
      if (await rename(list.id, next)) editing = false;
      else announce('Die Liste konnte nicht umbenannt werden. Bitte versuche es erneut.');
    } finally {
      saving = false;
    }
  }

  function handleInputKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveRename();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }
</script>

<div class="group/sidebar relative flex items-center">
  <div
    role="button"
    tabindex="0"
    class="relative flex min-h-9 w-full cursor-pointer items-center gap-2.25 rounded-md bg-transparent px-2.5 py-2.25 text-left text-[13px] text-text hover:bg-hover aria-[current=page]:font-semibold aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-1.5 aria-[current=page]:before:-left-1 aria-[current=page]:before:w-[3px] aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-accent aria-[current=page]:before:content-[''] max-mobile:min-h-11"
    aria-label={list.name}
    aria-current={!settings && active ? 'page' : undefined}
    data-task-drop-list={list.id}
    class:bg-selected={!settings && active}
    class:text-accent={!settings && active}
    onclick={select}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        select();
      }
    }}
  >
    <Hash class="shrink-0 text-muted-soft" size={17} aria-hidden="true" />
    {#if editing}
      <input
        bind:this={input}
        class="w-0 min-w-0 flex-1 rounded-md border border-border bg-surface px-1.25 py-0.75 text-[13px] text-text"
        aria-label="Listenname"
        aria-invalid={!draft.trim()}
        bind:value={draft}
        maxlength="2000"
        disabled={busy || saving}
        onpointerdown={stopRowInteraction}
        onmousedown={stopRowInteraction}
        ontouchstart={stopRowInteraction}
        onclick={stopRowInteraction}
        onkeydown={handleInputKeydown}
        onblur={() => void saveRename()}
      />
    {:else}
      <span class="min-w-0 wrap-anywhere" data-testid="account-list">{list.name}</span>
    {/if}
    <span class="relative ml-auto h-5 w-8 min-w-8">
      <span
        class="ml-auto block text-right text-[11px] leading-5 text-muted tabular-nums group-focus-within/sidebar:invisible group-hover/sidebar:invisible group-has-[button[data-state=open]]/sidebar:invisible [@media(hover:none)]:invisible"
        >{count || ''}</span
      >
      <ListActionsMenu
        name={list.name}
        rename={() => void startRename()}
        remove={() => remove(list)}
      />
    </span>
  </div>
  <ListDropTarget name={list.name} {session} {assign} />
</div>
