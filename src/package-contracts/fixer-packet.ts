import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const FIXER_PREREQUISITE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const trimNonblankString = Type.String({ pattern: "\\S" });

export const fixerPrerequisiteSchema = Type.Object({
  id: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
  requirement: trimNonblankString,
}, { additionalProperties: false });

export const fixerPacketV1Schema = Type.Object({
  version: Type.Literal(1),
  instructions: trimNonblankString,
  prerequisites: Type.Array(fixerPrerequisiteSchema),
}, { additionalProperties: false });

type ParsedFixPacketV1 = Static<typeof fixerPacketV1Schema>;
export type FixerPrerequisite = Readonly<Static<typeof fixerPrerequisiteSchema>>;
export type FixPacketV1 = Readonly<{
  version: 1;
  instructions: string;
  prerequisites: readonly FixerPrerequisite[];
}>;

export class FixPacketValidationError extends Error {
  readonly code = "AK_INVALID_FIX_PACKET";

  constructor(cause?: unknown) {
    super(
      "FixPacketV1 violates the exact packet contract",
      cause === undefined ? undefined : { cause },
    );
    this.name = "FixPacketValidationError";
  }
}

function fail(cause: unknown): never {
  throw new FixPacketValidationError(cause);
}

function schemaValidationCause(value: unknown): Error {
  const details = Value.Errors(fixerPacketV1Schema, value)
    .map(({ instancePath, message }) => `${instancePath || "/"}: ${message}`)
    .join("; ");
  return new Error(
    `FixPacketV1 schema validation failed${details.length === 0 ? "" : `: ${details}`}`,
  );
}

export function validateFixPacketV1(value: unknown): FixPacketV1 {
  if (!Value.Check(fixerPacketV1Schema, value)) fail(schemaValidationCause(value));
  const parsed = value as ParsedFixPacketV1;
  const ids = new Set<string>();
  const prerequisites = parsed.prerequisites.map((entry) => {
    if (ids.has(entry.id)) {
      fail(new Error(`FixPacketV1 contains duplicate prerequisite id: ${entry.id}`));
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, requirement: entry.requirement });
  });
  return Object.freeze({
    version: 1 as const,
    instructions: parsed.instructions,
    prerequisites: Object.freeze(prerequisites),
  });
}

export function parseFixPacketV1(source: string): FixPacketV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    fail(error);
  }
  return validateFixPacketV1(decoded);
}
