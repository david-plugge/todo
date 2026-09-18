<script lang="ts">
  import { Calendar, Popover } from 'bits-ui';
  import {
    CalendarDate,
    parseDate,
    today,
    getLocalTimeZone,
    type DateValue,
  } from '@internationalized/date';
  import { CalendarDays, Flag, ChevronLeft, ChevronRight, Sun, Sunrise, X } from '@lucide/svelte';
  import { dateLabel } from '$lib/domain/dates';
  let {
    value,
    kind,
    label,
    disabled = false,
    compact = false,
    onchange,
  }: {
    value: string | null | undefined;
    kind: 'planned' | 'due';
    label: string;
    disabled?: boolean;
    compact?: boolean;
    onchange: (value: string | null) => void;
  } = $props();
  let open = $state(false);
  let placeholder = $state<DateValue>(today(getLocalTimeZone()));
  const years = $derived(
    Array.from(
      { length: Math.min(9999, placeholder.year + 10) - Math.max(1, placeholder.year - 10) + 1 },
      (_, index) => Math.max(1, placeholder.year - 10) + index,
    ),
  );
  const selected = $derived(value ? parseDate(value) : undefined);
  const heading = $derived(kind === 'planned' ? 'Geplant am' : 'Fällig am');
  const shortDate = $derived(
    value
      ? new Intl.DateTimeFormat('de-DE', {
          day: 'numeric',
          month: 'short',
          ...(value.slice(0, 4) !== String(new Date().getFullYear())
            ? { year: 'numeric' as const }
            : {}),
          timeZone: 'UTC',
        }).format(new Date(`${value}T12:00:00Z`))
      : '',
  );
  function choose(date: DateValue | undefined) {
    const next = date?.toString() ?? null;
    if (next !== (value ?? null)) onchange(next);
    open = false;
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (next) placeholder = selected ?? today(getLocalTimeZone());
  }}
>
  <Popover.Trigger
    type="button"
    class={`relative inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center gap-1.25 rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] leading-5 whitespace-nowrap text-muted hover:bg-selected disabled:cursor-default disabled:opacity-40 max-mobile:after:absolute max-mobile:after:inset-x-0 max-mobile:after:-inset-y-2.5 max-mobile:after:content-[''] ${compact ? '' : 'max-mobile:min-h-9 max-mobile:min-w-9'} ${value && kind === 'planned' ? 'text-[#4f704a]' : ''} ${value && kind === 'due' ? 'text-[#805d33] group-data-[overdue=true]/task:text-danger' : ''}`}
    data-has-date={!!value}
    data-date={value ?? ''}
    aria-label={label}
    title={`${heading}${value ? ': ' + dateLabel(value) : ''}`}
    {disabled}
  >
    {#if kind === 'planned'}<CalendarDays size={15} aria-hidden="true" />{:else}<Flag
        size={15}
        aria-hidden="true"
      />{/if}
    <span>{value ? shortDate : kind === 'planned' ? 'Geplant für' : 'Fällig am'}</span>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="z-10000 max-h-(--bits-popover-content-available-height) w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-[13px] text-text shadow-[0_12px_36px_#28332224,0_2px_6px_#2833220c]"
      data-testid="date-popover"
      aria-label={heading}
      align="start"
      sideOffset={8}
      collisionPadding={12}
    >
      <div class="flex items-center justify-between pt-0 pr-0.5 pb-1.5 pl-1.5">
        <strong class="font-semibold">{heading}</strong><Popover.Close
          class="inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.75 rounded-md border-0 bg-transparent p-1.5 text-inherit hover:bg-selected disabled:cursor-default disabled:opacity-35"
          aria-label="Kalender schließen"
          title="Schließen"><X size={16} /></Popover.Close
        >
      </div>
      <div class="mb-2 flex gap-1.5 border-b border-border pb-2.5">
        <button
          class="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.75 rounded-md border-0 bg-transparent p-1.5 text-inherit hover:bg-selected disabled:cursor-default disabled:opacity-35"
          type="button"
          onclick={() => choose(today(getLocalTimeZone()))}><Sun size={15} />Heute</button
        >
        <button
          class="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.75 rounded-md border-0 bg-transparent p-1.5 text-inherit hover:bg-selected disabled:cursor-default disabled:opacity-35"
          type="button"
          onclick={() => choose(today(getLocalTimeZone()).add({ days: 1 }))}
          ><Sunrise size={15} />Morgen</button
        >
      </div>
      <Calendar.Root
        type="single"
        value={selected}
        bind:placeholder
        onValueChange={choose}
        locale="de-DE"
        calendarLabel={heading}
        weekStartsOn={1}
        weekdayFormat="short"
        fixedWeeks
        minValue={new CalendarDate(1, 1, 1)}
        maxValue={new CalendarDate(9999, 12, 31)}
      >
        {#snippet children({ months, weekdays })}
          <Calendar.Header class="mb-2 flex items-center justify-between">
            <Calendar.PrevButton>
              {#snippet child({ props })}<button
                  class="inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.75 rounded-md border-0 bg-transparent p-1.5 text-inherit hover:bg-selected disabled:cursor-default disabled:opacity-35"
                  {...props}
                  aria-label="Vorheriger Monat"><ChevronLeft size={16} /></button
                >{/snippet}
            </Calendar.PrevButton>
            <div class="m-0 flex gap-1 text-[13px]">
              <Calendar.MonthSelect
                class="max-w-30 cursor-pointer rounded-md border-0 bg-transparent px-0.5 py-1.5 text-inherit"
                aria-label="Monat"
              /><Calendar.YearSelect
                class="max-w-30 cursor-pointer rounded-md border-0 bg-transparent px-0.5 py-1.5 text-inherit"
                {years}
                aria-label="Jahr"
              />
            </div>
            <Calendar.NextButton>
              {#snippet child({ props })}<button
                  class="inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.75 rounded-md border-0 bg-transparent p-1.5 text-inherit hover:bg-selected disabled:cursor-default disabled:opacity-35"
                  {...props}
                  aria-label="Nächster Monat"><ChevronRight size={16} /></button
                >{/snippet}
            </Calendar.NextButton>
          </Calendar.Header>
          {#each months as month (month.value.toString())}
            <Calendar.Grid class="w-full table-fixed border-collapse">
              <Calendar.GridHead
                ><Calendar.GridRow
                  >{#each weekdays as weekday (weekday)}<Calendar.HeadCell
                      class="h-7 text-[11px] font-normal text-muted">{weekday}</Calendar.HeadCell
                    >{/each}</Calendar.GridRow
                ></Calendar.GridHead
              >
              <Calendar.GridBody>
                {#each month.weeks as week (week[0].toString())}
                  <Calendar.GridRow
                    >{#each week as date (date.toString())}<Calendar.Cell
                        class="py-0.5 text-center"
                        {date}
                        month={month.value}
                        ><Calendar.Day
                          class="inline-flex size-[34px] min-h-[34px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-inherit tabular-nums hover:bg-selected data-outside-month:text-muted data-outside-month:opacity-50 data-selected:bg-accent data-selected:text-white data-selected:hover:bg-accent-hover data-today:shadow-[inset_0_0_0_1px_var(--color-focus)]"
                          data-date={date.toString()}>{date.day}</Calendar.Day
                        ></Calendar.Cell
                      >{/each}</Calendar.GridRow
                  >
                {/each}
              </Calendar.GridBody>
            </Calendar.Grid>
          {/each}
        {/snippet}
      </Calendar.Root>
      <button
        class="mt-2.5 inline-flex min-h-9 w-full cursor-pointer items-center justify-center gap-1.75 rounded-none border-0 border-t border-border bg-transparent p-1.5 pt-3 text-muted hover:bg-selected disabled:cursor-default disabled:opacity-35"
        type="button"
        disabled={!value}
        onclick={() => choose(undefined)}><X size={14} />Datum entfernen</button
      >
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
