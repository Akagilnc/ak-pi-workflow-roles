import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const FIXER_PREREQUISITE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

export const fixerPrerequisiteSchema = Type.Object({
  id: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
  requirement: Type.String({ pattern: "\\S" }),
}, { additionalProperties: false });

export const fixerPrerequisitesSchema = Type.Array(fixerPrerequisiteSchema);
export type FixerPrerequisite = Readonly<Static<typeof fixerPrerequisiteSchema>>;
export type FixerInvocationInput = Readonly<{
  instructions: string;
  prerequisites: readonly FixerPrerequisite[];
}>;

function parseFailure(value: unknown): never {
  if (!Array.isArray(value)) throw new Error("Fixer prerequisites must be a JSON array");
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Fixer prerequisite entry must be an object with id and requirement fields");
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("requirement")) throw new Error("Fixer prerequisite entry fields must be exactly id and requirement");
    if (typeof (entry as Record<string, unknown>).id !== "string" || !(new RegExp(FIXER_PREREQUISITE_ID_PATTERN)).test((entry as { id: string }).id)) throw new Error(`Fixer prerequisite id violates pattern ${FIXER_PREREQUISITE_ID_PATTERN}`);
    if (typeof (entry as Record<string, unknown>).requirement !== "string" || !/\S/.test((entry as { requirement: string }).requirement)) throw new Error("Fixer prerequisite requirement must be nonblank");
  }
  throw new Error("Fixer prerequisites violate the attachment schema");
}

export function validateFixerPrerequisites(value: unknown): readonly FixerPrerequisite[] {
  if (!Value.Check(fixerPrerequisitesSchema, value)) parseFailure(value);
  const entries = value as Static<typeof fixerPrerequisitesSchema>;
  const ids = new Set<string>();
  const prerequisites = entries.map((entry) => {
    if (ids.has(entry.id)) throw new Error(`Fixer prerequisites contain duplicate id: ${entry.id}`);
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, requirement: entry.requirement });
  });
  return Object.freeze(prerequisites);
}

export function parseFixerPrerequisites(source: string): readonly FixerPrerequisite[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error("Fixer prerequisites must contain valid JSON");
  }
  return validateFixerPrerequisites(decoded);
}
