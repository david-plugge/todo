<script lang="ts">
  import { Hash, Repeat2 } from '@lucide/svelte';
  import { Collapsible, Popover } from 'bits-ui';
  import { Drawer } from 'vaul-svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { TaskChanges } from '$lib/domain/commands';
  import type { Task, TaskList } from '$lib/domain/models';
  import { isBlankNote, renderNote } from '$lib/domain/markdown';
  import RecurrenceEditor from './RecurrenceEditor.svelte';
  import TaskDatePicker from './TaskDatePicker.svelte';
  let {
    task,
    lists,
    expanded,
    showList = true,
    save,
    busy,
    close,
  }: {
    busy: boolean;
    close: () => void;
    task: Task;
    lists: TaskList[];
    expanded: boolean;
    showList?: boolean;
    save: (changes: TaskChanges) => Promise<boolean>;
  } = $props();

  let recurrenceOpen = $state(false);
  let wasExpanded = $state<boolean | undefined>(undefined);
  let editingNote = $state(false);
  let noteDraft = $state('');
  const note = $derived(task.description ?? '');
  const renderedNote = $derived(isBlankNote(note) ? '' : renderNote(note));

  // A stable action focuses once on mount; an inline attachment would re-run on
  // every keystroke and pull focus back after blur.
  function focusNote(area: HTMLTextAreaElement) {
    area.focus({ preventScroll: true });
  }

  function startNote(area?: HTMLTextAreaElement) {
    noteDraft = note;
    editingNote = true;
    area?.focus();
  }

  async function commitNote() {
    const next = noteDraft.trim();
    editingNote = false;
    if (next === note.trim()) return;
    await save({ description: next || null });
  }

  $effect(() => {
    if (wasExpanded === true && !expanded) recurrenceOpen = false;
    wasExpanded = expanded;
  });

  function changePlannedDate(plannedDate: string | null) {
    const recurrenceChanges =
      task.recurrenceRule && !task.dueDate
        ? plannedDate
          ? { recurrenceDate: plannedDate }
          : { recurrenceRule: null }
        : {};
    void save({ plannedDate, ...recurrenceChanges });
  }

  function changeDueDate(dueDate: string | null) {
    const nextAnchor = dueDate ?? task.plannedDate ?? null;
    const recurrenceChanges = task.recurrenceRule
      ? nextAnchor
        ? { recurrenceDate: nextAnchor }
        : { recurrenceRule: null }
      : {};
    void save({ dueDate, ...recurrenceChanges });
  }
  const wide = new MediaQuery('(min-width: 36.25rem)');
  const recurrenceTriggerClass = $derived(
    `relative inline-flex min-h-6 cursor-pointer items-center justify-center gap-1.25 rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] leading-5 whitespace-nowrap text-muted hover:bg-selected disabled:cursor-default disabled:opacity-40 max-mobile:after:absolute max-mobile:after:inset-x-0 max-mobile:after:-inset-y-2.5 max-mobile:after:content-[''] ${task.recurrenceRule ? 'text-accent' : ''}`,
  );
</script>

<div
  class={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ${expanded ? 'mt-0.5 mr-0 mb-0 -ml-1' : 'm-0 -ml-1'}`}
>
  {#if task.plannedDate}<TaskDatePicker
      kind="planned"
      label="Geplant am bearbeiten"
      value={task.plannedDate}
      compact={!expanded}
      onchange={changePlannedDate}
    />
  {/if}
  {#if task.dueDate}<TaskDatePicker
      kind="due"
      label="Fällig am bearbeiten"
      value={task.dueDate}
      compact={!expanded}
      onchange={changeDueDate}
    />
  {/if}
  {#if expanded && !task.plannedDate}<TaskDatePicker
      kind="planned"
      label="Geplant am bearbeiten"
      value={task.plannedDate}
      compact={!expanded}
      onchange={changePlannedDate}
    />
  {/if}
  {#if expanded && !task.dueDate}<TaskDatePicker
      kind="due"
      label="Fällig am bearbeiten"
      value={task.dueDate}
      compact={!expanded}
      onchange={changeDueDate}
    />
  {/if}
  {#if expanded || task.recurrenceRule}
    {#snippet recurrenceTrigger()}
      <Repeat2 size={15} aria-hidden="true" />
      <span>{task.recurrenceRule ? 'Wiederholt sich' : 'Wiederholen'}</span>
    {/snippet}
    {#if wide.current}
      <Popover.Root bind:open={recurrenceOpen}>
        <Popover.Trigger
          type="button"
          class={recurrenceTriggerClass}
          aria-label={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
          title={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
          disabled={busy}
        >
          {@render recurrenceTrigger()}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            class="z-10000 max-h-(--bits-popover-content-available-height) w-[min(380px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-[13px] text-text shadow-popover"
            data-testid="recurrence-popover"
            aria-label="Wiederholung"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            interactOutsideBehavior={busy ? 'ignore' : 'close'}
            escapeKeydownBehavior={busy ? 'ignore' : 'close'}
          >
            <RecurrenceEditor
              recurrenceRule={task.recurrenceRule}
              recurrenceDate={task.recurrenceDate}
              startDate={task.dueDate ?? task.plannedDate}
              disabled={busy}
              {save}
              close={() => {
                recurrenceOpen = false;
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    {:else}
      <!-- A save in flight must not be interrupted by a swipe or a tap outside. -->
      <Drawer.Root bind:open={recurrenceOpen} dismissible={!busy}>
        <Drawer.Trigger
          type="button"
          class={recurrenceTriggerClass}
          aria-label={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
          title={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
          disabled={busy}
        >
          {@render recurrenceTrigger()}
        </Drawer.Trigger>
        <Drawer.Portal>
          <Drawer.Overlay class="fixed inset-0 z-10000 bg-overlay" />
          <Drawer.Content
            class="fixed inset-x-0 bottom-0 z-10001 flex max-h-[90dvh] flex-col rounded-t-[20px] bg-surface text-[13px] text-text shadow-drawer outline-none"
            data-testid="recurrence-popover"
            aria-label="Wiederholung"
          >
            <Drawer.Handle
              class="mx-auto mt-2.5 mb-1 h-1 w-10 shrink-0 rounded-full bg-border-strong"
            />
            <div
              class="min-h-0 overflow-y-auto px-3 pt-1 pb-[calc(12px+env(safe-area-inset-bottom))]"
            >
              <RecurrenceEditor
                recurrenceRule={task.recurrenceRule}
                recurrenceDate={task.recurrenceDate}
                startDate={task.dueDate ?? task.plannedDate}
                disabled={busy}
                {save}
                close={() => {
                  recurrenceOpen = false;
                }}
              />
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    {/if}
  {/if}
  {#if !expanded && task.listId && showList}
    <span
      class="inline-flex max-w-[110px] items-center gap-1 truncate px-0 py-0.5 text-[11px] leading-5 text-muted"
      data-testid="task-list-label"
      ><Hash size={12} aria-hidden="true" />{lists.find((list) => list.id === task.listId)?.name ??
        'Liste nicht verfügbar'}</span
    >
  {/if}
</div>
<Collapsible.Content>
  <div class="mt-1.5" data-testid="task-note">
    {#if editingNote}
      <textarea
        class="min-h-20 w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] leading-[1.6] text-text"
        aria-label="Beschreibung bearbeiten"
        placeholder="Notiz, Markdown erlaubt …"
        maxlength="10000"
        disabled={busy}
        bind:value={noteDraft}
        onblur={() => void commitNote()}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            noteDraft = note;
            editingNote = false;
          }
        }}
        use:focusNote></textarea>
    {:else if renderedNote}
      <div
        class="cursor-text text-[13px] leading-[1.6] text-muted [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-selected [&_code]:px-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-selected [&_pre]:p-2"
        role="button"
        tabindex="0"
        aria-label="Beschreibung bearbeiten"
        onclick={() => startNote()}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            startNote();
          }
        }}
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in renderNote -->
        {@html renderedNote}
      </div>
    {:else}
      <button
        class="-ml-1 cursor-pointer rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] text-muted hover:bg-selected"
        type="button"
        disabled={busy}
        onclick={() => startNote()}>Beschreibung hinzufügen</button
      >
    {/if}
  </div>
  <div
    class={`relative mt-1 flex flex-nowrap items-center gap-2 border-t-0 pt-2 before:absolute before:top-0 before:-right-2 before:border-t before:border-border before:content-[''] max-mobile:gap-1 ${expanded ? 'before:left-[-41px] max-mobile:before:-left-11' : 'before:left-[-33px] max-mobile:before:-left-9'}`}
    data-testid="task-editor-footer"
  >
    <label class="flex min-w-0 flex-1 items-center gap-0.5 text-muted" title="Liste"
      ><Hash size={14} aria-hidden="true" /><select
        class="w-full max-w-45 min-w-0 rounded-md border-0 bg-transparent px-0.5 py-1.25 text-xs text-ellipsis text-text"
        aria-label="Liste bearbeiten"
        value={task.listId ?? ''}
        onchange={(event) => {
          const value = event.currentTarget.value || null;
          if (value !== (task.listId ?? null)) void save({ listId: value });
        }}
      >
        <option value="">Ohne Liste</option>{#each lists as list (list.id)}<option value={list.id}
            >{list.name}</option
          >{/each}
      </select></label
    >
    <div class="flex flex-none gap-1.5 max-mobile:gap-1" data-testid="task-footer-actions">
      <button
        class="min-h-9 cursor-pointer rounded-md border border-transparent bg-transparent px-2.5 py-1.75 text-xs whitespace-nowrap text-danger hover:bg-danger-soft disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        disabled={busy}
        onclick={() => void save({ deletedAt: Date.now() })}>Löschen</button
      >
      <button
        class="min-h-9 cursor-pointer rounded-md border border-transparent bg-selected px-2.5 py-1.75 text-xs whitespace-nowrap text-accent disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        aria-label="Details schließen"
        onclick={close}>Schließen</button
      >
    </div>
  </div>
</Collapsible.Content>
