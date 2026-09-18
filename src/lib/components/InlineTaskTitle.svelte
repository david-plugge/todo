<script lang="ts">
  import { untrack } from 'svelte';
  let {
    value,
    save,
    invalid,
  }: { value: string; save: (title: string) => Promise<boolean>; invalid: () => void } = $props();
  let draft = $state(untrack(() => value)),
    focused = $state(false),
    base = '',
    epoch = 0;
  $effect(() => {
    if (!focused) draft = value;
  });
  async function blur() {
    const next = draft.trim(),
      currentEpoch = epoch;
    if (next === base) {
      focused = false;
      return;
    }
    if (!next) {
      invalid();
      return;
    }
    if ((await save(next)) && currentEpoch === epoch) focused = false;
  }
  function focusTitle(node: HTMLInputElement) {
    node.focus({ preventScroll: true });
  }
</script>

<input
  use:focusTitle
  class="w-full rounded-none border-0 bg-transparent p-0 text-sm leading-[1.6] font-normal text-inherit focus:shadow-none"
  data-inline-task-title
  aria-label="Titel bearbeiten"
  bind:value={draft}
  maxlength="2000"
  onfocus={() => {
    epoch++;
    focused = true;
    base = value;
  }}
  onblur={blur}
  onkeydown={(event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      draft = base;
      event.currentTarget.blur();
    }
  }}
/>
