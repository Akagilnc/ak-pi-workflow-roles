export const CANONICAL_JSON_VALIDATION_ERROR_CODE = "canonical-json-invalid";
export class CanonicalJsonValidationError extends Error {
    path;
    reason;
    code = CANONICAL_JSON_VALIDATION_ERROR_CODE;
    constructor(path, reason) {
        super(`Canonical JSON validation failed at ${path}: ${reason}`);
        this.path = path;
        this.reason = reason;
        this.name = "CanonicalJsonValidationError";
    }
}
function childPath(path, segment) {
    return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function ownStringKeys(value, path) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
        throw new CanonicalJsonValidationError(childPath(path, "<symbol>"), "symbol-keyed member is not a JSON member");
    }
    return keys;
}
/** Deterministic serialization of the closed JSON value domain. */
export function canonicalJson(value) {
    const ancestors = new WeakSet();
    const serialize = (item, path) => {
        if (item === null)
            return "null";
        switch (typeof item) {
            case "boolean":
            case "string":
                return JSON.stringify(item);
            case "number":
                if (!Number.isFinite(item))
                    throw new CanonicalJsonValidationError(path, "number must be finite");
                return JSON.stringify(item);
            case "undefined":
            case "function":
            case "symbol":
            case "bigint":
                throw new CanonicalJsonValidationError(path, `${typeof item} is not a JSON value`);
            case "object": {
                if (ancestors.has(item))
                    throw new CanonicalJsonValidationError(path, "cycle is not a JSON value");
                ancestors.add(item);
                try {
                    if (Array.isArray(item)) {
                        if (Object.getPrototypeOf(item) !== Array.prototype)
                            throw new CanonicalJsonValidationError(path, "array must not be a custom object");
                        const keys = ownStringKeys(item, path);
                        const extraKey = keys.find((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length));
                        if (extraKey !== undefined)
                            throw new CanonicalJsonValidationError(childPath(path, extraKey), "non-index array member is not a JSON member");
                        const values = [];
                        for (let index = 0; index < item.length; index += 1) {
                            if (!Object.hasOwn(item, index))
                                throw new CanonicalJsonValidationError(childPath(path, index), "sparse array slot is not a JSON value");
                            values.push(serialize(item[index], childPath(path, index)));
                        }
                        return `[${values.join(",")}]`;
                    }
                    const prototype = Object.getPrototypeOf(item);
                    if (prototype !== Object.prototype && prototype !== null)
                        throw new CanonicalJsonValidationError(path, "object must be a plain record");
                    return `{${ownStringKeys(item, path).sort().map((key) => `${JSON.stringify(key)}:${serialize(item[key], childPath(path, key))}`).join(",")}}`;
                }
                finally {
                    ancestors.delete(item);
                }
            }
        }
        throw new Error("Unreachable canonical JSON value type");
    };
    return serialize(value, "$");
}
export function canonicalJsonBytes(value) {
    return new TextEncoder().encode(canonicalJson(value));
}
