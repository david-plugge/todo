<script lang="ts">
  import { Repeat2 } from '@lucide/svelte';
  import { Popover } from 'bits-ui';
  import { Drawer } from 'vaul-svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { TaskChanges } from '$lib/domain/commands';
  import RecurrenceEditor from './RecurrenceEditor.svelte';
  let {
    open = $bindable(false),
    compact = false,
    recurrenceRule,
    recurrenceDate,
    startDate,
    busy,
    save,
  }: {
    open?: boolean;
    compact?: boolean;
    recurrenceRule: string | null | undefined;
    recurrenceDate: string | null | undefined;
    startDate: string | null | undefined;
    busy: boolean;
    save: (changes: TaskChanges) => Promise<boolean>;
  } = $props();

  const wide = new MediaQuery('(min-width: 36.25rem)');
  const triggerClass = $derived(
    `relative inline-flex min-h-6 cursor-pointer items-center justify-center gap-1.25 rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] leading-5 whitespace-nowrap text-muted hover:bg-selected disabled:cursor-default disabled:opacity-40 max-mobile:after:absolute max-mobile:after:inset-x-0 max-mobile:after:-inset-y-2.5 max-mobile:after:content-[''] ${compact ? '' : 'max-mobile:min-h-9 max-mobile:min-w-9'} ${recurrenceRule ? 'text-accent' : ''}`,
  );
  const triggerLabel = $derived(
    recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen',
  );
</script>

{#snippet trigger()}
  <Repeat2 size={15} aria-hidden="true" />
  <span>{recurrenceRule ? 'Wiederholt sich' : 'Wiederholen'}</span>
{/snippet}
{#snippet editor(close: () => void)}
  <RecurrenceEditor {recurrenceRule} {recurrenceDate} {startDate} disabled={busy} {save} {close} />
{/snippet}
{#if wide.current}
  <Popover.Root bind:open>
    <Popover.Trigger
      type="button"
      class={triggerClass}
      aria-label={triggerLabel}
      title={triggerLabel}
      disabled={busy}
    >
      {@render trigger()}
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
        {@render editor(() => {
          open = false;
        })}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <!-- A save in flight must not be interrupted by a swipe or a tap outside. -->
  <Drawer.Root bind:open dismissible={!busy}>
    <Drawer.Trigger
      type="button"
      class={triggerClass}
      aria-label={triggerLabel}
      title={triggerLabel}
      disabled={busy}
    >
      {@render trigger()}
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
        <div class="min-h-0 overflow-y-auto px-3 pt-1 pb-[calc(12px+env(safe-area-inset-bottom))]">
          {@render editor(() => {
            open = false;
          })}
        </div>
      </Drawer.Content>
    </Drawer.Portal>
  </Drawer.Root>
{/if}
