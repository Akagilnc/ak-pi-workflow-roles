export const CANONICAL_JSON_VALIDATION_ERROR_CODE = "canonical-json-invalid" as const;

export class CanonicalJsonValidationError extends Error {
  readonly code = CANONICAL_JSON_VALIDATION_ERROR_CODE;

  constructor(readonly path: string, readonly reason: string) {
    super(`Canonical JSON validation failed at ${path}: ${reason}`);
    this.name = "CanonicalJsonValidationError";
  }
}

function childPath(path: string, segment: string | number): string {
  return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Deterministic serialization of the closed JSON value domain. */
export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();

  const serialize = (item: unknown, path: string): string => {
    if (item === null) return "null";
    switch (typeof item) {
      case "boolean":
      case "string":
        return JSON.stringify(item);
      case "number":
        if (!Number.isFinite(item)) throw new CanonicalJsonValidationError(path, "number must be finite");
        return JSON.stringify(item);
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        throw new CanonicalJsonValidationError(path, `${typeof item} is not a JSON value`);
      case "object": {
        if (ancestors.has(item)) throw new CanonicalJsonValidationError(path, "cycle is not a JSON value");
        ancestors.add(item);
        try {
          if (Array.isArray(item)) {
            if (Object.getPrototypeOf(item) !== Array.prototype) throw new CanonicalJsonValidationError(path, "array must not be a custom object");
            const values: string[] = [];
            for (let index = 0; index < item.length; index += 1) {
              if (!Object.hasOwn(item, index)) throw new CanonicalJsonValidationError(childPath(path, index), "sparse array slot is not a JSON value");
              values.push(serialize(item[index], childPath(path, index)));
            }
            return `[${values.join(",")}]`;
          }
          const prototype = Object.getPrototypeOf(item);
          if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonValidationError(path, "object must be a plain record");
          return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${serialize((item as Record<string, unknown>)[key], childPath(path, key))}`).join(",")}}`;
        } finally {
          ancestors.delete(item);
        }
      }
    }
    throw new Error("Unreachable canonical JSON value type");
  };

  return serialize(value, "$");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
