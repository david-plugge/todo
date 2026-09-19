import {
  SOURCES,
  TRIGGERS,
  setAriaStrings,
  type DndEvent,
  type DndEventInfo,
} from 'svelte-dnd-action';

export const taskDragType = 'todo-task';
export const flipDurationMs = 160;

/** Shared by source and sidebar destinations, which both finalize a cross-zone drop. */
export function dragSession() {
  let source: SOURCES | undefined;
  let cancelled = false;
  return {
    start(info: DndEventInfo) {
      if (info.trigger === TRIGGERS.DRAG_STARTED) {
        source = info.source;
        cancelled = false;
      }
    },
    get cancelled() {
      return cancelled;
    },
    controls(node: HTMLElement) {
      setAriaStrings({
        dragStarted: ({ itemLabel }) =>
          `${itemLabel} aufgenommen. Mit Pfeiltasten verschieben oder mit Tab eine Liste wählen.`,
        movedToPosition: ({ itemLabel, position }) => `${itemLabel}: Position ${position}.`,
        movedToZoneEnd: ({ itemLabel, zoneLabel }) => `${itemLabel} am Ende von ${zoneLabel}.`,
        movedToZoneStart: ({ itemLabel, zoneLabel }) => `${itemLabel} am Anfang von ${zoneLabel}.`,
        dropped: ({ itemLabel, zoneLabel }) => `${itemLabel} in ${zoneLabel} abgelegt.`,
        zoneActiveInstruction:
          'Zeile fokussieren und mit Leertaste oder Enter aufnehmen. Pfeiltasten verschieben; Leertaste, Enter oder Escape beenden.',
        zoneDragDisabledInstruction: 'Hier können Aufgaben abgelegt werden.',
      });
      const cancel = (event: Event) => {
        if (source !== SOURCES.POINTER) return;
        if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
        cancelled = true;
        // The library finalizes pointer drags on mouseup, including touch drags.
        // Keep cancellation out of persistence while letting it clean up the clone/listeners.
        window.dispatchEvent(new MouseEvent('mouseup'));
        source = undefined;
      };
      const protect = (event: Event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('input, select, textarea, button, a, [contenteditable="true"]')
        )
          event.stopPropagation();
      };
      window.addEventListener('keydown', cancel, true);
      window.addEventListener('touchcancel', cancel, true);
      node.addEventListener('mousedown', protect, true);
      node.addEventListener('touchstart', protect, true);
      return {
        destroy() {
          window.removeEventListener('keydown', cancel, true);
          window.removeEventListener('touchcancel', cancel, true);
          node.removeEventListener('mousedown', protect, true);
          node.removeEventListener('touchstart', protect, true);
        },
      };
    },
  };
}
export type DragSession = ReturnType<typeof dragSession>;

/** Persist only the moved record; preview arrays and shadow items never enter the store. */
export function moveTarget<T extends { id: string }>(event: DndEvent<T>, original: T[]) {
  const index = event.items.findIndex((item) => item.id === event.info.id);
  if (index < 0) return undefined;
  const before = event.items[index + 1]?.id ?? null;
  const originalIndex = original.findIndex((item) => item.id === event.info.id);
  return originalIndex >= 0 && (original[originalIndex + 1]?.id ?? null) !== before
    ? before
    : undefined;
}

/** Let the library morph geometry; only the clone's presentation changes by destination. */
export function compactTaskPreview(element?: HTMLElement, data?: { title?: string }) {
  if (!element) return;
  element.classList.add('compact-drag');
  let title = element.querySelector<HTMLElement>('.compact-drag-title');
  if (!title) {
    title = document.createElement('span');
    title.className = 'compact-drag-title';
    element.append(title);
  }
  title.textContent = data?.title ?? '';
}
export function fullTaskPreview(element?: HTMLElement) {
  element?.classList.remove('compact-drag');
}
