<script lang="ts">
  import TaskDatePicker from './TaskDatePicker.svelte';
  import { Plus, Hash } from '@lucide/svelte';
  import type { TaskList } from '$lib/domain/models';
  import type { CreateTaskOptions } from '$lib/domain/commands';
  import { canSubmitDraft, shouldResetDraft } from './task-composer-state';
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
  let pending = $state(false);
  let draftEpoch = 0;
  function changeDraft() {
    draftEpoch++;
  }
  async function submit() {
    if (!canSubmitDraft(pending, title)) return;
    const submittedAt = draftEpoch;
    pending = true;
    try {
      const saved = await create(title.trim(), {
        dueDate: due || null,
        plannedDate: planned === undefined ? defaultDate : planned,
        listId: newList || null,
      });
      if (saved && shouldResetDraft(submittedAt, draftEpoch)) {
        title = '';
        expanded = false;
        due = '';
        planned = undefined;
        changeDraft();
      }
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
    class={`flex items-center gap-3 pl-2.5 max-mobile:flex-wrap max-mobile:gap-[15px] ${expanded ? 'px-3 pt-1 pb-0' : 'py-1'}`}
  >
    <span class={`text-accent ${expanded ? 'hidden' : 'flex'}`} aria-hidden="true"
      ><Plus size={19} /></span
    ><input
      class="min-w-0 flex-1 border-0 bg-transparent px-0 py-2.5 text-sm text-text placeholder:text-muted focus:shadow-none"
      disabled={!ready}
      aria-label="Neuer Task"
      placeholder="Aufgabe hinzufügen"
      bind:value={title}
      oninput={changeDraft}
      maxlength="2000"
      required
    />
  </div>
  <div class={`${expanded ? 'flex' : 'hidden'} flex-wrap items-center gap-2.5 px-3 py-1`}>
    <TaskDatePicker
      kind="planned"
      label="Geplant am"
      value={planned === undefined ? defaultDate : planned}
      onchange={(value) => {
        planned = value;
        changeDraft();
      }}
    />
    <TaskDatePicker
      kind="due"
      label="Fällig am"
      value={due}
      onchange={(value) => {
        due = value ?? '';
        changeDraft();
      }}
    />
  </div>
  <div
    class={`${expanded ? 'flex' : 'hidden'} mt-1 flex-nowrap items-center gap-2 px-3 pt-2 pb-2.5 max-mobile:gap-1`}
    data-testid="task-composer-footer"
  >
    <label class="flex min-w-0 flex-1 items-center gap-0.5 text-muted" title="Liste"
      ><Hash size={14} aria-hidden="true" /><select
        class="w-full max-w-45 min-w-0 rounded-md border-0 bg-transparent px-0.5 py-1.25 text-xs text-ellipsis text-text"
        aria-label="Liste"
        bind:value={newList}
        onchange={changeDraft}
        ><option value="">Ohne Liste</option>{#each orderedLists as list (list.id)}<option
            value={list.id}>{list.name}</option
          >{/each}</select
      ></label
    >
    <div class="flex flex-none gap-1.5 max-mobile:gap-1">
      <button
        class="min-h-9 cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1.75 text-xs whitespace-nowrap text-accent hover:bg-[#edf0e7] max-mobile:min-h-10 max-mobile:p-2"
        type="button"
        onclick={() => {
          title = '';
          due = '';
          planned = undefined;
          expanded = false;
          changeDraft();
        }}>Abbrechen</button
      >
      <button
        class="min-h-9 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1.75 text-xs whitespace-nowrap text-white hover:bg-accent-hover disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        aria-label="Task erstellen"
        disabled={!ready || busy || pending || !title.trim()}
        >{pending ? 'Wird hinzugefügt …' : 'Hinzufügen'}</button
      >
    </div>
  </div>
</form>
