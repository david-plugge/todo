import { RRule, type Options, type Weekday } from 'rrule';
import { validDate } from './dates';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateOnlyFrequencies = new Set([RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY]);

const structuredRuleFields: Array<keyof Options> = [
  'wkst',
  'count',
  'until',
  'tzid',
  'bysetpos',
  'bymonth',
  'bymonthday',
  'bynmonthday',
  'byyearday',
  'byweekno',
  'byweekday',
  'bynweekday',
  'byhour',
  'byminute',
  'bysecond',
  'byeaster',
];

function onlyUses(options: Partial<Options>, allowed: Array<keyof Options>) {
  return structuredRuleFields.every((field) => allowed.includes(field) || options[field] == null);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isSingleNumber(value: number | number[] | null | undefined, expected: number) {
  const numbers = asArray(value);
  return numbers.length === 1 && numbers[0] === expected;
}

function normalizedWeekdays(
  value: Weekday | string | Array<Weekday | string | number> | number | null | undefined,
): Weekday[] {
  if (value == null) return [];
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

/**
 * Whether the compact recurrence editor can represent this rule without changing
 * its meaning. Rules outside this subset stay read-only in the UI so opening a
 * popover can never discard constraints such as multiple month days.
 */
export function isRecurrenceRuleStructurallyEditable(
  value: string,
  anchorDate: string | null | undefined,
): boolean {
  if (!validDate(anchorDate) || anchorDate == null) return false;
  const [, month, day] = anchorDate.split('-').map(Number);
  try {
    const options = RRule.parseString(value);
    if (options.freq == null) return false;
    const days = normalizedWeekdays(options.byweekday);
    if (options.freq === RRule.DAILY) return onlyUses(options, []);
    if (options.freq === RRule.WEEKLY)
      return (
        onlyUses(options, ['byweekday']) &&
        days.length > 0 &&
        days.every((weekday) => weekday.n === undefined)
      );
    if (options.freq === RRule.MONTHLY) {
      if (days.length > 0)
        return (
          onlyUses(options, ['byweekday']) &&
          days.length === 1 &&
          days[0].n != null &&
          (days[0].n === -1 || (days[0].n >= 1 && days[0].n <= 5))
        );
      return onlyUses(options, ['bymonthday']) && isSingleNumber(options.bymonthday, day);
    }
    if (options.freq === RRule.YEARLY)
      return (
        onlyUses(options, ['bymonth', 'bymonthday']) &&
        isSingleNumber(options.bymonth, month) &&
        isSingleNumber(options.bymonthday, day)
      );
    return false;
  } catch {
    return false;
  }
}

export function validUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

/** Validate a date-only recurrence and return its stable RFC representation. */
export function canonicalRecurrenceRule(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim()))
    throw new Error('Ungültige Wiederholungsregel');
  try {
    const rule = RRule.fromString(value.trim());
    if (!dateOnlyFrequencies.has(rule.options.freq)) throw new Error('Not a calendar frequency');
    if (rule.origOptions.count != null || rule.origOptions.until != null)
      throw new Error('Bounded rules are not supported');
    if (
      rule.origOptions.byhour != null ||
      rule.origOptions.byminute != null ||
      rule.origOptions.bysecond != null
    )
      throw new Error('Time components are not supported');
    return rule.toString().replace(/^RRULE:/, '');
  } catch {
    throw new Error('Ungültige Wiederholungsregel');
  }
}

export function validRecurrenceRule(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    canonicalRecurrenceRule(value);
    return true;
  } catch {
    return false;
  }
}

const calendarDate = (value: string) => new Date(`${value}T12:00:00.000Z`);
const formatDate = (value: Date) => value.toISOString().slice(0, 10);

/** Calculate the next occurrence strictly after the current recurrence date. */
export function nextOccurrenceDate(ruleValue: string, recurrenceDate: string): string | null {
  if (!validDate(recurrenceDate) || recurrenceDate === null)
    throw new Error('Ungültiges Wiederholungsdatum');
  const canonical = canonicalRecurrenceRule(ruleValue);
  const parsed = RRule.fromString(canonical);
  const rule = new RRule({ ...parsed.origOptions, dtstart: calendarDate(recurrenceDate) });
  const next = rule.after(calendarDate(recurrenceDate), false);
  return next ? formatDate(next) : null;
}

export function shiftCalendarDate(
  value: string | null | undefined,
  fromDate: string,
  toDate: string,
): string | null | undefined {
  if (value == null) return value;
  if (!validDate(value) || !validDate(fromDate) || !validDate(toDate))
    throw new Error('Ungültiges Kalenderdatum');
  const offset = calendarDate(toDate).getTime() - calendarDate(fromDate).getTime();
  return formatDate(new Date(calendarDate(value).getTime() + offset));
}

const parseUuid = (value: string): Uint8Array => {
  if (!validUuid(value)) throw new Error('Ungültige Serien-ID');
  return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, (byte) => parseInt(byte, 16));
};

/** RFC 4122 UUIDv5 with the series UUID as namespace and occurrence date as name. */
export async function occurrenceId(seriesId: string, occurrenceDate: string): Promise<string> {
  if (!validDate(occurrenceDate) || occurrenceDate === null)
    throw new Error('Ungültiges Wiederholungsdatum');
  const namespace = parseUuid(seriesId);
  const name = new TextEncoder().encode(occurrenceDate);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
