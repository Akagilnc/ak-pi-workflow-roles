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

/**
 * #836 r16 class 2: root `required` stays empty except for the machine execution
 * discriminator the caller names (e.g. `status`/`judgeStatus`) — code branches on
 * it to pick the next move (worker gate, judge/countersign queue, gatekeeper
 * queue, terminating-tools projection). Every other field is narrative content
 * the LLM owns and stays optional. Callers with no such discriminator (e.g.
 * Collector output) pass no `requiredKeys` and get the prior zero-required shape.
 */
function discriminatorRequired(properties: Record<string, unknown>, requiredKeys: readonly string[]): string[] {
  return requiredKeys.filter((key) => key in properties);
}

/** Collapse transport variants into one provider-compatible open object; only `requiredKeys` stay required. */
export function openToolObjectFromUnion(schema: UnionSchema, requiredKeys: readonly string[] = []): TSchema {
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
  (object as unknown as { required: string[] }).required = discriminatorRequired(properties, requiredKeys);
  return object;
}

/** Open a pre-existing object transport schema without changing declarations; only `requiredKeys` stay required. */
export function openToolObject(schema: TSchema & { properties: Record<string, TSchema> }, requiredKeys: readonly string[] = []): TSchema {
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, declaration]) => [name, Type.Optional(described(name, declaration))]));
  const object = Type.Object(properties, { additionalProperties: true });
  (object as unknown as { required: string[] }).required = discriminatorRequired(properties, requiredKeys);
  return object;
}
