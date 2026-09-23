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
    const descriptors = ownDataDescriptors(value);
    for (const [key, descriptor] of descriptors) {
      // Cause has a dedicated recursive field below; serializing both copies
      // would consume the shared cycle guard and turn causeChain into a marker.
      if (key === "cause") continue;
      transferred[key] = transferNestedValue(descriptor.value, depth + 1, seen);
    }
    // V8 exposes Error.stack as an own accessor even after an explicit stack assignment.
    if (!("stack" in transferred)) {
      try {
        const stack = value.stack;
        if (typeof stack === "string") transferred.stack = stack;
      } catch {
        // A hostile stack getter must not replace the original failure.
      }
    }
    const cause = descriptors.find(([key]) => key === "cause")?.[1];
    return {
      errorKind: "Error",
      constructorName: safeConstructorName(value),
      ...transferred,
      ...(cause === undefined || !("value" in cause) || cause.value === undefined
        ? {}
        : {
            causeChain:
              depth >= 10
                ? "[cause-chain-depth-limit]"
                : serializeThrownValue(cause.value, depth + 1, seen),
          }),
    };
  }
  return transferNestedValue(value, depth, seen);
}

function safeConstructorName(value: object): string | undefined {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name;
  } catch {
    return undefined;
  }
}

function transferNestedValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof Error) return serializeThrownValue(value, depth, seen);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= 10) return "[nested-depth-limit]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => transferNestedValue(item, depth + 1, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const transferred: Record<string, unknown> = {};
    for (const [key, descriptor] of ownDataDescriptors(value)) {
      transferred[key] = transferNestedValue(descriptor.value, depth + 1, seen);
    }
    return transferred;
  }
  return value;
}

function ownDataDescriptors(value: object): Array<[string, PropertyDescriptor]> {
  try {
    return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) =>
      "value" in descriptor
    );
  } catch {
    // An uninspectable Proxy is diagnostic data, not a reason to replace the throw.
    return [];
  }
}
