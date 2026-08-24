/**
 * Shared analyst median primitive (family-wide convention).
 * Odd sample count → single middle value after ascending sort.
 * Even sample count → arithmetic mean of the two middle values.
 * Empty input → undefined (callers record typed vacancy; no invented zero).
 */
export function medianNumber(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
