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

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

export class FixerPacketValidationError extends Error {
  readonly code = "AK_INVALID_FIX_PACKET";

  constructor(cause?: unknown) {
    const prefix = "Fixer prerequisites or instructions violate the invocation contract";
    super(
      cause === undefined ? prefix : `${prefix}: ${causeMessage(cause)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "FixerPacketValidationError";
  }
}

function fail(cause: unknown): never {
  throw new FixerPacketValidationError(cause);
}

function parseFailure(value: unknown): never {
  if (!Array.isArray(value)) fail(new Error("Fixer prerequisites must be a JSON array"));
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(new Error("Fixer prerequisite entry must be an object with id and requirement fields"));
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("requirement")) {
      fail(new Error("Fixer prerequisite entry fields must be exactly id and requirement"));
    }
    if (
      typeof (entry as Record<string, unknown>).id !== "string" ||
      !(new RegExp(FIXER_PREREQUISITE_ID_PATTERN)).test((entry as { id: string }).id)
    ) {
      fail(new Error(`Fixer prerequisite id violates pattern ${FIXER_PREREQUISITE_ID_PATTERN}`));
    }
    if (
      typeof (entry as Record<string, unknown>).requirement !== "string" ||
      !/\S/.test((entry as { requirement: string }).requirement)
    ) {
      fail(new Error("Fixer prerequisite requirement must be nonblank"));
    }
  }
  fail(new Error("Fixer prerequisites violate the attachment schema"));
}

export function validateFixerPrerequisites(value: unknown): readonly FixerPrerequisite[] {
  if (!Value.Check(fixerPrerequisitesSchema, value)) parseFailure(value);
  const entries = value as Static<typeof fixerPrerequisitesSchema>;
  const ids = new Set<string>();
  const prerequisites = entries.map((entry) => {
    if (ids.has(entry.id)) {
      fail(new Error(`Fixer prerequisites contain duplicate id: ${entry.id}`));
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, requirement: entry.requirement });
  });
  return Object.freeze(prerequisites);
}

export function parseFixerPrerequisites(source: string): readonly FixerPrerequisite[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    fail(error);
  }
  return validateFixerPrerequisites(decoded);
}
