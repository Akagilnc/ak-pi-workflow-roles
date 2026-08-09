import { Type, type TSchemaOptions, type TUnsafe } from "typebox";

/** A string enum in the flat schema form required by Google tool declarations. */
export function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: TSchemaOptions = {},
): TUnsafe<Values[number]> {
  return Type.Unsafe<Values[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}
