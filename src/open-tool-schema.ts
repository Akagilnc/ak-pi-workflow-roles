import { Type, type TSchema } from "typebox";

type UnionSchema = TSchema & { anyOf: Array<TSchema & { properties?: Record<string, TSchema> }> };

function described(name: string, schema: TSchema): TSchema {
  if (typeof (schema as { description?: unknown }).description === "string") return schema;
  throw new Error(`Tool field ${name} has no semantic description at its schema owner`);
}

function declarationIdentity(schema: TSchema): string {
  const { description: _description, ...semantic } = schema as TSchema & { description?: string };
  return JSON.stringify(semantic);
}

/** Collapse transport variants into one provider-compatible, zero-required open object. */
export function openToolObjectFromUnion(schema: UnionSchema): TSchema {
  const declarations = new Map<string, TSchema[]>();
  for (const variant of schema.anyOf) {
    for (const [name, declaration] of Object.entries(variant.properties ?? {})) {
      const entries = declarations.get(name) ?? [];
      const identity = declarationIdentity(declaration);
      if (!entries.some((entry) => declarationIdentity(entry) === identity)) entries.push(declaration);
      declarations.set(name, entries);
    }
  }
  const properties = Object.fromEntries([...declarations].map(([name, entries]) => {
    const descriptions = [...new Set(entries.map((entry) => (entry as { description?: unknown }).description).filter((value): value is string => typeof value === "string"))].join(" ");
    const declaration = entries.length === 1
      ? entries[0]!
      : Type.Union(entries, descriptions === "" ? {} : { description: descriptions });
    return [name, Type.Optional(described(name, declaration))];
  }));
  const object = Type.Object(properties, { additionalProperties: true });
  (object as unknown as { required: string[] }).required = [];
  return object;
}

/** Open a pre-existing object transport schema without changing declarations. */
export function openToolObject(schema: TSchema & { properties: Record<string, TSchema> }): TSchema {
  const object = Type.Object(
    Object.fromEntries(Object.entries(schema.properties).map(([name, declaration]) => [name, Type.Optional(described(name, declaration))])),
    { additionalProperties: true },
  );
  (object as unknown as { required: string[] }).required = [];
  return object;
}
