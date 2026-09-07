/**
 * Parent-visible relay of one gate bounce/finding item (#750 / #775).
 *
 * Strings stay as-is. Any other value is JSON-serialized so structured content
 * (article/reason/evidence, category/law/evidence, …) is not lost as
 * `[object Object]` when joined into parent-seat text.
 *
 * Presentation only: does not legislate carrier format for LLM-to-LLM traffic.
 */
export function readableGateItem(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Join gate items into one parent-visible line. */
export function joinReadableGateItems(
  items: readonly unknown[],
  separator = "; ",
): string {
  return items.map(readableGateItem).join(separator);
}
