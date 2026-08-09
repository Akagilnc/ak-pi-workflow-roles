import { Type } from "typebox";
function described(name, schema) {
    if (typeof schema.description === "string")
        return schema;
    throw new Error(`Tool field ${name} has no semantic description at its schema owner`);
}
function declarationIdentity(schema) {
    const { description: _description, ...semantic } = schema;
    return JSON.stringify(semantic);
}
/** Collapse transport variants into one provider-compatible, zero-required open object. */
export function openToolObjectFromUnion(schema) {
    const declarations = new Map();
    for (const variant of schema.anyOf) {
        for (const [name, declaration] of Object.entries(variant.properties ?? {})) {
            const entries = declarations.get(name) ?? [];
            const identity = declarationIdentity(declaration);
            if (!entries.some((entry) => declarationIdentity(entry) === identity))
                entries.push(declaration);
            declarations.set(name, entries);
        }
    }
    const properties = Object.fromEntries([...declarations].map(([name, entries]) => {
        const descriptions = [...new Set(entries.map((entry) => entry.description).filter((value) => typeof value === "string"))].join(" ");
        const declaration = entries.length === 1
            ? entries[0]
            : Type.Union(entries, descriptions === "" ? {} : { description: descriptions });
        return [name, Type.Optional(described(name, declaration))];
    }));
    const object = Type.Object(properties, { additionalProperties: true });
    object.required = [];
    return object;
}
/** Open a pre-existing object transport schema without changing declarations. */
export function openToolObject(schema) {
    const object = Type.Object(Object.fromEntries(Object.entries(schema.properties).map(([name, declaration]) => [name, Type.Optional(described(name, declaration))])), { additionalProperties: true });
    object.required = [];
    return object;
}
