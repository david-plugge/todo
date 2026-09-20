<script lang="ts">
  import TaskDatePicker from './TaskDatePicker.svelte';
  import ListSelect from './ListSelect.svelte';
  import RecurrenceField from './RecurrenceField.svelte';
  import { Plus } from '@lucide/svelte';
  import type { TaskList } from '$lib/domain/models';
  import type { CreateTaskOptions, TaskChanges } from '$lib/domain/commands';
  import { isBlankNote, renderNote } from '$lib/domain/markdown';
  import {
    anchorDraftRecurrence,
    canSubmitDraft,
    shouldResetDraft,
    type DraftRecurrence,
  } from './task-composer-state';
  let {
    expanded = $bindable(false),
    ready,
    busy,
    lists: orderedLists,
    defaultDate,
    newList = $bindable(''),
    create,
  }: {
    expanded?: boolean;
    ready: boolean;
    busy: boolean;
    lists: TaskList[];
    defaultDate: string | null;
    newList?: string;
    create: (title: string, options: CreateTaskOptions) => Promise<boolean>;
  } = $props();
  let title = $state(''),
    due = $state(''),
    planned = $state<string | null | undefined>(undefined);
  let note = $state('');
  let editingNote = $state(false);
  let noteDraft = $state('');
  let recurrence = $state<DraftRecurrence>({ rule: null, date: null });
  let recurrenceOpen = $state(false);
  let pending = $state(false);
  let draftEpoch = 0;
  const plannedDate = $derived(planned === undefined ? defaultDate : planned);
  const renderedNote = $derived(isBlankNote(note) ? '' : renderNote(note));

  // A stable action focuses once on mount; an inline attachment would re-run on
  // every keystroke and pull focus back after blur.
  function focusNote(area: HTMLTextAreaElement) {
    area.focus({ preventScroll: true });
  }

  function startNote() {
    noteDraft = note;
    editingNote = true;
  }

  function commitNote() {
    editingNote = false;
    const next = noteDraft.trim();
    if (next === note.trim()) return;
    note = next;
    changeDraft();
  }

  function changeDraft() {
    draftEpoch++;
  }

  function resetDraft() {
    title = '';
    due = '';
    planned = undefined;
    note = '';
    noteDraft = '';
    editingNote = false;
    recurrence = { rule: null, date: null };
    recurrenceOpen = false;
    expanded = false;
    changeDraft();
  }

  /** The recurrence editor writes into the draft; the rule is stored with the new task. */
  async function saveRecurrence(changes: TaskChanges) {
    recurrence = {
      rule: changes.recurrenceRule ?? null,
      date: (changes.recurrenceRule ? changes.recurrenceDate : null) ?? null,
    };
    changeDraft();
    return true;
  }

  function changePlannedDate(value: string | null) {
    planned = value;
    recurrence = anchorDraftRecurrence(recurrence, value, due || null);
    changeDraft();
  }

  function changeDueDate(value: string | null) {
    due = value ?? '';
    recurrence = anchorDraftRecurrence(recurrence, plannedDate, value);
    changeDraft();
  }

  async function submit() {
    if (!canSubmitDraft(pending, title)) return;
    const submittedAt = draftEpoch;
    pending = true;
    try {
      const saved = await create(title.trim(), {
        description: note.trim() || null,
        dueDate: due || null,
        plannedDate,
        listId: newList || null,
        ...(recurrence.rule && recurrence.date
          ? { recurrenceRule: recurrence.rule, recurrenceDate: recurrence.date }
          : {}),
      });
      if (saved && shouldResetDraft(submittedAt, draftEpoch)) resetDraft();
    } finally {
      pending = false;
    }
  }
</script>

<form
  class={`mt-4 rounded-lg border border-transparent border-t-border pt-2 ${expanded ? 'border-border bg-surface' : ''}`}
  data-testid="task-composer"
  onfocusin={() => {
    expanded = true;
  }}
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <div
    class={`flex items-center gap-3 pl-2.5 max-mobile:flex-wrap max-mobile:gap-[15px] ${expanded ? 'px-2 pt-2 pb-0' : 'py-1'}`}
  >
    <span class={`text-accent ${expanded ? 'hidden' : 'flex'}`} aria-hidden="true"
      ><Plus size={19} /></span
    ><input
      class={`min-w-0 flex-1 rounded-md border-0 bg-transparent text-sm text-text placeholder:text-muted focus:shadow-none focus-visible:outline-offset-2 ${expanded ? 'px-2 py-1.5' : 'px-0 py-2.5'}`}
      disabled={!ready}
      aria-label="Neuer Task"
      placeholder="Aufgabe hinzufügen"
      bind:value={title}
      oninput={changeDraft}
      maxlength="2000"
      required
    />
  </div>
  <div class={`${expanded ? 'block' : 'hidden'} px-4 pt-2`} data-testid="task-composer-note">
    {#if editingNote}
      <textarea
        class="min-h-20 w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] leading-[1.6] text-text focus-visible:outline-offset-2"
        aria-label="Beschreibung bearbeiten"
        placeholder="Notiz, Markdown erlaubt …"
        maxlength="10000"
        disabled={!ready}
        bind:value={noteDraft}
        onblur={commitNote}
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
        class="cursor-text rounded-md text-[13px] leading-[1.6] text-muted focus-visible:outline-offset-2 [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-selected [&_code]:px-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-selected [&_pre]:p-2"
        role="button"
        tabindex="0"
        aria-label="Beschreibung bearbeiten"
        onclick={startNote}
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
        class="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[11px] text-muted hover:bg-selected focus-visible:outline-offset-2 max-mobile:min-h-11 max-mobile:text-xs"
        type="button"
        disabled={!ready}
        onclick={startNote}>Beschreibung hinzufügen</button
      >
    {/if}
  </div>
  <div
    class={`${expanded ? 'flex' : 'hidden'} flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-2 pr-4 pl-3`}
  >
    <TaskDatePicker
      kind="planned"
      label="Geplant am"
      value={plannedDate}
      onchange={changePlannedDate}
    />
    <TaskDatePicker kind="due" label="Fällig am" value={due} onchange={changeDueDate} />
    <RecurrenceField
      bind:open={recurrenceOpen}
      recurrenceRule={recurrence.rule}
      recurrenceDate={recurrence.date}
      startDate={due || plannedDate}
      busy={!ready || pending}
      save={saveRecurrence}
    />
  </div>
  <div
    class={`${expanded ? 'flex' : 'hidden'} flex-nowrap items-center gap-2 px-4 pt-2 pb-3 max-mobile:gap-1`}
    data-testid="task-composer-footer"
  >
    <div class="-ml-1.5 flex min-w-0 flex-1 items-center">
      <ListSelect
        label="Liste"
        lists={orderedLists}
        value={newList || null}
        disabled={!ready}
        onchange={(listId) => {
          newList = listId ?? '';
          changeDraft();
        }}
      />
    </div>
    <div class="flex flex-none gap-1.5 max-mobile:gap-1">
      <button
        class="min-h-9 cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1.75 text-xs whitespace-nowrap text-accent hover:bg-hover max-mobile:min-h-10 max-mobile:p-2"
        type="button"
        onclick={resetDraft}>Abbrechen</button
      >
      <button
        class="min-h-9 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1.75 text-xs whitespace-nowrap text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        aria-label="Task erstellen"
        disabled={!ready || busy || pending || !title.trim()}
        >{pending ? 'Wird hinzugefügt …' : 'Hinzufügen'}</button
      >
    </div>
  </div>
</form>
