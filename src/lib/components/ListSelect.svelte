<script lang="ts">
  import { Check, ChevronDown, Hash } from '@lucide/svelte';
  import { Select } from 'bits-ui';
  import { Drawer } from 'vaul-svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { TaskList } from '$lib/domain/models';
  let {
    value,
    lists,
    label,
    disabled = false,
    onchange,
  }: {
    value: string | null;
    lists: TaskList[];
    label: string;
    disabled?: boolean;
    onchange: (value: string | null) => void;
  } = $props();

  const wide = new MediaQuery('(min-width: 36.25rem)');
  let open = $state(false);
  const items = $derived([
    { value: '', label: 'Ohne Liste' },
    ...lists.map((list) => ({ value: list.id, label: list.name })),
  ]);
  const selected = $derived(items.find((item) => item.value === (value ?? '')));
  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[13px] text-text outline-0 select-none data-highlighted:bg-selected data-[disabled]:opacity-40 max-mobile:min-h-11 max-mobile:px-3 max-mobile:text-sm';
</script>

{#snippet options()}
  {#each items as item (item.value)}
    <Select.Item class={itemClass} value={item.value} label={item.label}>
      {#snippet children({ selected: isSelected })}
        <Hash class="shrink-0 text-muted" size={14} aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        {#if isSelected}<Check class="shrink-0 text-accent" size={14} aria-hidden="true" />{/if}
      {/snippet}
    </Select.Item>
  {/each}
{/snippet}

<Select.Root
  type="single"
  {items}
  {disabled}
  bind:open
  value={value ?? ''}
  onValueChange={(next) => {
    if (next !== (value ?? '')) onchange(next || null);
  }}
>
  <Select.Trigger
    class="inline-flex min-h-9 w-full max-w-45 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-text hover:bg-selected data-[state=open]:border-border data-[state=open]:bg-selected disabled:cursor-default disabled:opacity-40"
    aria-label={label}
  >
    <Hash class="shrink-0 text-muted" size={14} aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate text-left"
      >{selected?.label ?? 'Liste nicht verfügbar'}</span
    >
    <ChevronDown class="shrink-0 text-muted" size={14} aria-hidden="true" />
  </Select.Trigger>
  {#if wide.current}
    <Select.Portal>
      <Select.Content
        class="z-10000 max-h-(--bits-select-content-available-height) w-(--bits-select-anchor-width) min-w-45 rounded-[7px] border border-border bg-surface p-1 shadow-menu"
        data-testid="list-select-content"
        sideOffset={6}
        collisionPadding={12}
      >
        <Select.Viewport>{@render options()}</Select.Viewport>
      </Select.Content>
    </Select.Portal>
  {:else}
    <Drawer.Root bind:open>
      <Drawer.Portal>
        <Drawer.Overlay class="fixed inset-0 z-10000 bg-overlay" />
        <Drawer.Content
          class="fixed inset-x-0 bottom-0 z-10001 flex max-h-[80dvh] flex-col rounded-t-[20px] bg-surface text-text shadow-drawer outline-none"
          aria-label={`${label} auswählen`}
        >
          <Drawer.Handle
            class="mx-auto mt-2.5 mb-1 h-1 w-10 shrink-0 rounded-full bg-border-strong"
          />
          <Select.ContentStatic
            class="min-h-0 overflow-y-auto p-2 pb-[calc(12px+env(safe-area-inset-bottom))]"
            data-testid="list-select-content"
          >
            <Select.Viewport>{@render options()}</Select.Viewport>
          </Select.ContentStatic>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  {/if}
</Select.Root>
