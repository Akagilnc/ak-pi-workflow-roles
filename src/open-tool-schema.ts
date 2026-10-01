import { Type, type TSchema } from "typebox";

function described(name: string, schema: TSchema): TSchema {
  if (typeof (schema as { description?: unknown }).description === "string") return schema;
  throw new Error(`Tool field ${name} has no semantic description at its schema owner`);
}

/**
 * One open tool object per submission tool. Every field stays optional, the root
 * accepts extra keys, and each field declaration carries a semantic description
 * with no type/nesting/enum/length constraint (#1134): the package declaration
 * is what the host validates before dispatch, so anything narrower than a name
 * plus its meaning is a rejection rule no owner approved.
 */
export function openToolObject(
  schema: TSchema & { properties: Record<string, TSchema> },
): TSchema {
  const object = Type.Object(
    Object.fromEntries(Object.entries(schema.properties).map(([name, declaration]) => [
      name,
      Type.Optional(described(name, declaration)),
    ])),
    { additionalProperties: true },
  );
  (object as unknown as { required: string[] }).required = [];
  return object;
}