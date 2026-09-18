/** Bounded fractional positions: 128-bit, fixed-width lowercase hex sorts as plain text. */
const MAX = (1n << 128n) - 1n;
export const validRank = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{32}$/.test(value) &&
  value !== '0'.repeat(32) &&
  value !== 'f'.repeat(32);
const encode = (value: bigint) => value.toString(16).padStart(32, '0');
export function between(left: string | null, right: string | null): string | null {
  if ((left !== null && !validRank(left)) || (right !== null && !validRank(right)))
    throw new Error('Invalid rank');
  const a = left === null ? 0n : BigInt(`0x${left}`),
    b = right === null ? MAX : BigInt(`0x${right}`);
  if (a >= b || b - a < 2n) return null;
  return encode((a + b) / 2n);
}
export function balanced(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid rank count');
  const step = MAX / BigInt(count + 1);
  return Array.from({ length: count }, (_, index) => encode(step * BigInt(index + 1)));
}
export interface Ranked {
  id: string;
  rank?: string;
  createdAt?: number;
  deletedAt?: number;
}
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function compareRank(a: Ranked, b: Ranked): number {
  // Existing unranked records retain their previous task order and follow ranked records.
  if (a.rank && b.rank) return compareText(a.rank, b.rank) || compareText(a.id, b.id);
  if (a.rank || b.rank) return a.rank ? -1 : 1;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0) || compareText(a.id, b.id);
}
/** Plan one insertion/move. Rebalance only when legacy rows, ties or exhausted gaps require it. */
export function planPlacement(
  rows: Ranked[],
  id: string,
  beforeId: string | null,
): Map<string, string> {
  const active = rows.filter((row) => row.deletedAt === undefined).sort(compareRank);
  if (beforeId === id) return new Map();
  const others = active.filter((row) => row.id !== id);
  const index = beforeId === null ? others.length : others.findIndex((row) => row.id === beforeId);
  if (index < 0) throw new Error('Move target no longer exists');
  const usable = others.every((row) => validRank(row.rank));
  const rank = usable
    ? between(others[index - 1]?.rank ?? null, others[index]?.rank ?? null)
    : null;
  if (rank !== null) return new Map([[id, rank]]);
  // Entire local repair, including all corresponding outbox entries, commits atomically.
  const order = others.map((row) => row.id);
  order.splice(index, 0, id);
  const ranks = balanced(order.length);
  return new Map(order.map((key, i) => [key, ranks[i]]));
}
