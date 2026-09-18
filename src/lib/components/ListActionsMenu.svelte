<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import { Ellipsis, Pencil, Trash2 } from '@lucide/svelte';

  let { name, rename, remove }: { name: string; rename: () => void; remove: () => void } = $props();

  function stopRowInteraction(event: Event) {
    event.stopPropagation();
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="absolute top-1/2 right-0 z-1 inline-grid size-8 min-h-8 min-w-8 -translate-y-1/2 place-items-center border-0 bg-transparent p-1.5 text-muted opacity-0 group-focus-within/sidebar:opacity-100 group-hover/sidebar:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
    aria-label={`Optionen für ${name}`}
    onpointerdown={stopRowInteraction}
    onmousedown={stopRowInteraction}
    ontouchstart={stopRowInteraction}
    onclick={stopRowInteraction}
    onkeydown={stopRowInteraction}
  >
    <Ellipsis size={17} aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      class="z-120 min-w-37 rounded-[7px] border border-border bg-canvas p-1 shadow-[0_8px_24px_#28332224]"
      sideOffset={6}
      align="end"
    >
      <DropdownMenu.Item
        class="flex w-full cursor-pointer items-center gap-2 rounded-sm p-2 text-xs text-text outline-0 data-highlighted:bg-selected"
        onSelect={rename}><Pencil size={15} aria-hidden="true" /> Umbenennen</DropdownMenu.Item
      >
      <DropdownMenu.Item
        class="flex w-full cursor-pointer items-center gap-2 rounded-sm p-2 text-xs text-text outline-0 data-highlighted:bg-selected"
        onSelect={remove}><Trash2 size={15} aria-hidden="true" /> Löschen</DropdownMenu.Item
      >
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
