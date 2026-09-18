<script lang="ts">
  import { RRule, type Weekday } from 'rrule';
  import { ToggleGroup } from 'bits-ui';
  import { untrack } from 'svelte';
  import type { TaskChanges } from '$lib/domain/commands';
  import { isRecurrenceRuleStructurallyEditable } from '$lib/domain/recurrence';

  type Unit = 'day' | 'week' | 'month' | 'year';
  type MonthMode = 'date' | 'weekday';
  const monthModeId = $props.id();
  const monthModeName = `recurrence-month-mode-${monthModeId}`;

  const weekdays = [
    { value: 'MO', short: 'Mo' },
    { value: 'TU', short: 'Di' },
    { value: 'WE', short: 'Mi' },
    { value: 'TH', short: 'Do' },
    { value: 'FR', short: 'Fr' },
    { value: 'SA', short: 'Sa' },
    { value: 'SU', short: 'So' },
  ] as const;
  const weekdayByJsDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

  let {
    recurrenceRule,
    recurrenceDate,
    startDate,
    disabled = false,
    save,
    close,
  }: {
    recurrenceRule: string | null | undefined;
    recurrenceDate: string | null | undefined;
    startDate: string | null | undefined;
    disabled?: boolean;
    save: (changes: TaskChanges) => Promise<boolean>;
    close: () => void;
  } = $props();

  let interval = $state(1);
  let unit = $state<Unit>('week');
  let selectedDays = $state<string[]>([]);
  let monthMode = $state<MonthMode>('date');
  let monthOrdinal = $state(1);
  let monthWeekday = $state('MO');
  let pending = $state(false);
  let saveError = $state('');
  let initialized = $state(false);
  let anchor = $state<string | null>(null);
  let sourceRule = $state<string | null>(null);
  let readOnlyRule = $state(false);
  let draftDirty = $state(false);
  const anchorParts = $derived(anchor ? parseDate(anchor) : null);
  const weeklySelectionValid = $derived(unit !== 'week' || selectedDays.length > 0);

  // A recurrence editor is a draft. In particular, do not observe task changes after
  // it opens: sync can update the task while the user is choosing a rule.
  $effect(() => {
    if (initialized) return;
    initialized = true;
    anchor = untrack(() => startDate ?? null);
    const initialRule = untrack(() => recurrenceRule ?? null);
    sourceRule = initialRule;
    if (initialRule) readStructuredRule(initialRule);
    else initializeDefaults();
  });

  function parseDate(value: string) {
    const [year, month, day] = value.split('-').map(Number);
    return { year, month, day };
  }

  function dateToUtc(value: string) {
    const { year, month, day } = parseDate(value);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }

  function anchorWeekday() {
    return anchor ? weekdayByJsDay[dateToUtc(anchor).getUTCDay()] : 'MO';
  }

  function initializeDefaults() {
    interval = 1;
    unit = 'week';
    selectedDays = [anchorWeekday()];
    monthMode = 'date';
    monthWeekday = anchorWeekday();
    monthOrdinal = Math.min(5, Math.ceil((anchorParts?.day ?? 1) / 7));
  }

  function readStructuredRule(rule: string) {
    try {
      const options = RRule.parseString(rule);
      if (!isRecurrenceRuleStructurallyEditable(rule, anchor)) {
        readOnlyRule = true;
        return;
      }
      readOnlyRule = false;
      interval = Math.max(1, options.interval ?? 1);
      unit =
        options.freq === RRule.DAILY
          ? 'day'
          : options.freq === RRule.MONTHLY
            ? 'month'
            : options.freq === RRule.YEARLY
              ? 'year'
              : 'week';
      const ruleDays = normalizeWeekdays(options.byweekday);
      selectedDays = ruleDays.length ? ruleDays.map((day) => weekdayCode(day)) : [anchorWeekday()];
      const ordinalDay = ruleDays.find((day) => day.n !== undefined);
      if (unit === 'month' && ordinalDay) {
        monthMode = 'weekday';
        monthOrdinal = ordinalDay.n === -1 ? -1 : Math.min(5, Math.max(1, ordinalDay.n ?? 1));
        monthWeekday = weekdayCode(ordinalDay);
      } else {
        monthMode = 'date';
      }
    } catch {
      readOnlyRule = true;
    }
  }

  function normalizeWeekdays(
    value: Weekday | string | Array<Weekday | string | number> | number | null | undefined,
  ): Weekday[] {
    if (value === null || value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).flatMap((day) => {
      if (typeof day === 'number') return [];
      if (typeof day !== 'string') return [day];
      const match = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
      if (!match) return [];
      const base =
        RRule[match[2] as keyof Pick<typeof RRule, 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'>];
      return [match[1] ? base.nth(Number(match[1])) : base];
    });
  }

  function weekdayCode(day: Weekday) {
    return String(day).replace(/^\+?[-\d]*/, '');
  }

  function buildRule(): string | null {
    if (readOnlyRule) return null;
    const every = `INTERVAL=${Math.max(1, Math.floor(interval || 1))}`;
    if (unit === 'day') return `FREQ=DAILY;${every}`;
    if (unit === 'week' && selectedDays.length === 0) return null;
    if (unit === 'week') return `FREQ=WEEKLY;${every};BYDAY=${selectedDays.join(',')}`;
    if (unit === 'year' && anchorParts)
      return `FREQ=YEARLY;${every};BYMONTH=${anchorParts.month};BYMONTHDAY=${anchorParts.day}`;
    if (unit === 'month' && monthMode === 'weekday')
      return `FREQ=MONTHLY;${every};BYDAY=${monthOrdinal}${monthWeekday}`;
    return `FREQ=MONTHLY;${every};BYMONTHDAY=${anchorParts?.day ?? 1}`;
  }

  function sortWeekdays(days: string[]) {
    return [...days].sort(
      (left, right) =>
        weekdays.findIndex((weekday) => weekday.value === left) -
        weekdays.findIndex((weekday) => weekday.value === right),
    );
  }

  function setSelectedDays(days: string[]) {
    selectedDays = sortWeekdays(days);
    markDraftDirty();
  }

  function markDraftDirty() {
    draftDirty = true;
    saveError = '';
  }

  async function apply() {
    if (!anchor || readOnlyRule || pending) return false;
    if (sourceRule && !draftDirty) {
      close();
      return true;
    }
    const rule = buildRule();
    if (!rule) return false;
    pending = true;
    saveError = '';
    try {
      const saved = await save({ recurrenceRule: rule, recurrenceDate: anchor });
      if (saved) close();
      else
        saveError = 'Die Wiederholung konnte nicht gespeichert werden. Bitte versuche es erneut.';
      return saved;
    } catch {
      saveError = 'Die Wiederholung konnte nicht gespeichert werden. Bitte versuche es erneut.';
      return false;
    } finally {
      pending = false;
    }
  }

  async function remove() {
    if (pending) return;
    pending = true;
    saveError = '';
    try {
      const saved = await save({ recurrenceRule: null, recurrenceDate: null });
      if (saved) close();
      else
        saveError = 'Die Wiederholung konnte nicht gespeichert werden. Bitte versuche es erneut.';
    } catch {
      saveError = 'Die Wiederholung konnte nicht gespeichert werden. Bitte versuche es erneut.';
    } finally {
      pending = false;
    }
  }
</script>

<section class="grid gap-3">
  {#if !anchor}
    <p
      class="m-0 rounded-md bg-danger-soft px-2.5 py-2 text-[11px] leading-normal text-danger"
      role="alert"
    >
      Lege zuerst ein Fälligkeits- oder Planungsdatum fest. Erst dann kann die Wiederholung
      gespeichert werden.
    </p>
  {:else if readOnlyRule}
    <p
      class="m-0 rounded-md bg-selected px-2.5 py-2 text-[11px] leading-normal text-muted"
      role="status"
    >
      Diese Wiederholungsregel enthält mehrere oder im Editor nicht darstellbare Termine. Sie wird
      unverändert geschützt angezeigt.
    </p>
  {:else}
    <div class="grid gap-3">
      <div
        class="grid max-w-[310px] grid-cols-[minmax(72px,0.35fr)_minmax(130px,1fr)] gap-2 max-mobile:max-w-none max-mobile:grid-cols-[1fr_1.5fr]"
      >
        <label class="grid gap-1.5 text-[11px] text-muted">
          Alle
          <input
            class="w-full rounded-md border border-border bg-surface px-2 py-1.75 text-[13px] text-text"
            type="number"
            min="1"
            max="999"
            value={interval}
            disabled={disabled || pending}
            onchange={(event) => {
              interval = Math.max(1, Math.min(999, Number(event.currentTarget.value) || 1));
              markDraftDirty();
            }}
          />
        </label>
        <label class="grid gap-1.5 text-[11px] text-muted">
          Einheit
          <select
            class="w-full rounded-md border border-border bg-surface px-2 py-1.75 text-[13px] text-text"
            value={unit}
            disabled={disabled || pending}
            onchange={(event) => {
              unit = event.currentTarget.value as Unit;
              markDraftDirty();
            }}
          >
            <option value="day">Tag(e)</option>
            <option value="week">Woche(n)</option>
            <option value="month">Monat(e)</option>
            <option value="year">Jahr(e)</option>
          </select>
        </label>
      </div>

      {#if unit === 'week'}
        <fieldset class="m-0 grid gap-1.75 border-0 p-0">
          <legend class="mb-1.5 text-[11px] text-muted">Wochentage</legend>
          <ToggleGroup.Root
            type="multiple"
            bind:value={() => selectedDays, setSelectedDays}
            disabled={disabled || pending}
            class="flex flex-wrap gap-1.25"
            aria-label="Wochentage auswählen"
            aria-describedby={weeklySelectionValid ? undefined : 'recurrence-weekday-validation'}
          >
            {#each weekdays as day (day.value)}
              <ToggleGroup.Item
                value={day.value}
                class="min-h-8 min-w-9 rounded-md border border-border bg-surface px-2 py-1.25 text-muted disabled:cursor-default disabled:opacity-40 data-[state=on]:border-accent data-[state=on]:bg-selected data-[state=on]:text-accent"
                aria-label={day.short}
                disabled={disabled || pending}>{day.short}</ToggleGroup.Item
              >
            {/each}
          </ToggleGroup.Root>
          {#if !weeklySelectionValid}
            <small id="recurrence-weekday-validation" class="text-[10px] text-danger" role="alert"
              >Wähle mindestens einen Wochentag aus.</small
            >
          {/if}
        </fieldset>
      {:else if unit === 'month'}
        <fieldset class="m-0 grid gap-1.75 border-0 p-0">
          <legend class="mb-1.5 text-[11px] text-muted">Monatlicher Termin</legend>
          <label class="flex flex-wrap items-center gap-1.75 text-xs text-text">
            <input
              class="m-0 size-4 accent-accent"
              type="radio"
              name={monthModeName}
              value="date"
              checked={monthMode === 'date'}
              disabled={disabled || pending}
              onchange={() => {
                monthMode = 'date';
                markDraftDirty();
              }}
            />
            Am gleichen Kalendertag ({anchorParts?.day}.)
          </label>
          <label class="flex flex-wrap items-center gap-1.75 text-xs text-text">
            <input
              class="m-0 size-4 accent-accent"
              type="radio"
              name={monthModeName}
              value="weekday"
              checked={monthMode === 'weekday'}
              disabled={disabled || pending}
              onchange={() => {
                monthMode = 'weekday';
                markDraftDirty();
              }}
            />
            Am
            <select
              class="w-auto rounded-md border border-border bg-surface px-2 py-1.75 text-[13px] text-text"
              aria-label="Position im Monat"
              value={monthOrdinal}
              disabled={disabled || pending || monthMode !== 'weekday'}
              onchange={(event) => {
                monthOrdinal = Number(event.currentTarget.value);
                markDraftDirty();
              }}
            >
              <option value={1}>ersten</option>
              <option value={2}>zweiten</option>
              <option value={3}>dritten</option>
              <option value={4}>vierten</option>
              <option value={5}>fünften</option>
              <option value={-1}>letzten</option>
            </select>
            <select
              class="w-auto rounded-md border border-border bg-surface px-2 py-1.75 text-[13px] text-text"
              aria-label="Wochentag im Monat"
              value={monthWeekday}
              disabled={disabled || pending || monthMode !== 'weekday'}
              onchange={(event) => {
                monthWeekday = event.currentTarget.value;
                markDraftDirty();
              }}
            >
              {#each weekdays as day (day.value)}<option value={day.value}>{day.short}</option
                >{/each}
            </select>
          </label>
        </fieldset>
      {/if}
    </div>
  {/if}
  {#if recurrenceRule}
    <button
      type="button"
      class="justify-self-start rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs text-danger hover:bg-danger-soft disabled:cursor-default disabled:opacity-40"
      disabled={disabled || pending}
      onclick={() => void remove()}>Wiederholung entfernen</button
    >
  {/if}
  {#if recurrenceRule && recurrenceDate && recurrenceDate !== anchor}
    <p
      class="m-0 rounded-md bg-danger-soft px-2.5 py-2 text-[11px] leading-normal text-danger"
      role="alert"
    >
      Das Wiederholungsdatum passt nicht zum aktuellen Fälligkeits- oder Planungsdatum.
    </p>
  {/if}
  {#if saveError}
    <p class="m-0 text-xs text-danger" role="alert">{saveError}</p>
  {/if}
  <div class="flex justify-end gap-1.5 border-t border-border pt-3">
    <button
      type="button"
      class="min-h-9 cursor-pointer rounded-md border border-border bg-surface px-3 py-1.75 text-xs text-accent hover:bg-selected disabled:cursor-default disabled:opacity-40"
      disabled={disabled || pending}
      onclick={close}>Abbrechen</button
    >
    {#if !readOnlyRule}
      <button
        type="button"
        class="min-h-9 cursor-pointer rounded-md border border-accent bg-accent px-3 py-1.75 text-xs text-white hover:bg-accent-hover disabled:cursor-default disabled:opacity-40"
        disabled={!anchor || !weeklySelectionValid || disabled || pending}
        onclick={() => void apply()}>{pending ? 'Speichert …' : 'Übernehmen'}</button
      >
    {/if}
  </div>
</section>
