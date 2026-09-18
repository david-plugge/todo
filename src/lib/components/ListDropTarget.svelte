<script lang="ts">
  import { dndzone, TRIGGERS, type DndEvent } from 'svelte-dnd-action';
  import type { Task } from '$lib/domain/models';
  import { taskDragType, compactTaskPreview, type DragSession } from '$lib/ui/drag';
  let {
    name,
    session,
    assign,
  }: { name: string; session: DragSession; assign: (id: string) => Promise<boolean> } = $props();
  let items = $state<Task[]>([]);
  function consider(event: CustomEvent<DndEvent<Task>>) {
    items = event.detail.info.trigger === TRIGGERS.DRAG_STOPPED ? [] : event.detail.items;
  }
  function finalize(event: CustomEvent<DndEvent<Task>>) {
    items = event.detail.items;
    if (!session.cancelled && event.detail.info.trigger === TRIGGERS.DROPPED_INTO_ZONE)
      void assign(event.detail.info.id);
    items = [];
  }
</script>

<div
  class={`pointer-events-none absolute inset-0 rounded-md ${items.length > 0 ? 'bg-[#dce9d255] outline-2 -outline-offset-2 outline-focus' : ''}`}
  data-testid="list-drop-target"
  data-active={items.length > 0}
  aria-label={`Nach ${name} verschieben`}
  use:dndzone={{
    items,
    type: taskDragType,
    dragDisabled: true,
    transformDraggedElement: compactTaskPreview,
    dropTargetStyle: {},
    zoneTabIndex: -1,
  }}
  onconsider={consider}
  onfinalize={finalize}
>
  {#each items as item (item.id)}<div
      class="h-8 w-full max-w-50"
      aria-label={item.title}
    ></div>{/each}
</div>
