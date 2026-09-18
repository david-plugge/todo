<script lang="ts" generics="T extends { id: string }">
  import { flushSync, onMount, untrack, type Snippet } from 'svelte';
  import { flip } from 'svelte/animate';
  import { dndzone, TRIGGERS, SOURCES, type DndEvent } from 'svelte-dnd-action';
  import { flipDurationMs, moveTarget, fullTaskPreview, type DragSession } from '$lib/ui/drag';
  let {
    items,
    type,
    label,
    itemLabel,
    session,
    move,
    announce,
    children,
  }: {
    items: T[];
    type: string;
    label: string;
    itemLabel: (item: T) => string;
    session: DragSession;
    move: (id: string, before: string | null) => Promise<boolean>;
    announce: (message: string) => void;
    children: Snippet<[T]>;
  } = $props();
  let duration = $state(flipDurationMs);
  onMount(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      duration = motion.matches ? 0 : flipDurationMs;
    };
    update();
    motion.addEventListener('change', update);
    return () => motion.removeEventListener('change', update);
  });
  let preview = $state<T[] | null>(null);
  const shown = $derived(preview ?? [...items]);
  let dragging = $state(false);
  let saving = $state(false);
  $effect(() => {
    void items;
    if (!untrack(() => dragging || saving)) preview = null;
  });
  function consider(event: CustomEvent<DndEvent<T>>) {
    session.start(event.detail.info);
    if (event.detail.info.trigger === TRIGGERS.DRAG_STARTED) {
      const zone = event.currentTarget as HTMLElement;
      const row = Array.from(zone.children).find(
        (element) => (element as HTMLElement).dataset.sortId === event.detail.info.id,
      );
      if (row) {
        // Collapse before the shadow is rendered. The library has already cloned the row,
        // so refresh its inert content as well; its positioning remains library-owned.
        flushSync(() => row.dispatchEvent(new Event('task-drag-start')));
        const clone = document.getElementById('dnd-action-dragged-el');
        if (clone)
          clone.replaceChildren(...Array.from(row.childNodes, (node) => node.cloneNode(true)));
      }
    }
    if (event.detail.info.trigger === TRIGGERS.DRAG_STOPPED) {
      dragging = false;
      preview = null;
      return;
    }
    dragging = true;
    preview = event.detail.items;
  }
  async function finalize(event: CustomEvent<DndEvent<T>>) {
    const { info } = event.detail;
    preview = event.detail.items;
    dragging = info.source === SOURCES.KEYBOARD && info.trigger === TRIGGERS.DROPPED_INTO_ZONE;
    if (session.cancelled || info.trigger === TRIGGERS.DROPPED_OUTSIDE_OF_ANY) {
      preview = null;
      announce(session.cancelled ? 'Verschieben abgebrochen.' : 'Reihenfolge unverändert.');
      return;
    }
    const before = moveTarget(event.detail, items);
    if (info.trigger === TRIGGERS.DROPPED_INTO_ZONE && before !== undefined) {
      saving = true;
      try {
        if (await move(info.id, before)) announce('Neue Reihenfolge gespeichert.');
      } finally {
        saving = false;
      }
    }
    if (before === undefined && info.trigger === TRIGGERS.DROPPED_INTO_ZONE)
      announce('Reihenfolge unverändert.');
    if (!dragging) preview = null;
  }
</script>

<div
  class="[&>[data-sortable-row]+[data-sortable-row]_article]:border-t-border"
  data-dnd-type={type}
  aria-label={label}
  use:dndzone={{
    items: shown,
    type,
    flipDurationMs: duration,
    delayTouchStart: 180,
    useCursorForDetection: true,
    transformDraggedElement: fullTaskPreview,
    dropTargetStyle: {},
    dropFromOthersDisabled: true,
  }}
  onconsider={consider}
  onfinalize={finalize}
>
  {#each shown as item (item.id)}
    <div
      class="relative rounded-sm hover:[&_article:not([data-expanded=true])]:bg-[#f5f5ee]"
      data-sortable-row
      data-sort-id={item.id}
      aria-label={itemLabel(item)}
      animate:flip={{ duration }}
    >
      {@render children(item)}
    </div>
  {/each}
</div>
