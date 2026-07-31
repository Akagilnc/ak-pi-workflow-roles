/** Deterministic JSON serialization for normalized package identities and comparisons. */
export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function canonicalJsonBytes(value) {
    return new TextEncoder().encode(canonicalJson(value));
}
