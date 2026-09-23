/** Preserve a thrown value's own data, including non-enumerable Error fields and causes. */
export function serializeThrownValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const transferred: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      // Cause has a dedicated recursive field below; serializing both copies
      // would consume the shared cycle guard and turn causeChain into a marker.
      if (key === "cause") continue;
      transferred[key] = transferNestedValue(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return {
      errorKind: "Error",
      constructorName: value.constructor?.name,
      ...transferred,
      ...(value.cause === undefined
        ? {}
        : {
            causeChain:
              depth >= 10
                ? "[cause-chain-depth-limit]"
                : serializeThrownValue(value.cause, depth + 1, seen),
          }),
    };
  }
  return transferNestedValue(value, depth, seen);
}

function transferNestedValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof Error) return serializeThrownValue(value, depth, seen);
  if (depth >= 10) return "[nested-depth-limit]";
  if (Array.isArray(value)) {
    return value.map((item) => transferNestedValue(item, depth + 1, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const transferred: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      transferred[key] = transferNestedValue(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return transferred;
  }
  return value;
}
