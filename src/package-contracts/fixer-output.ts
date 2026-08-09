import { Type, type Static } from "typebox";
import { FIXER_PREREQUISITE_ID_PATTERN, type FixerInvocationInput } from "./fixer-packet.ts";
import { openToolObjectFromUnion } from "../open-tool-schema.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const FIXER_ACCEPTED_TEXT = "Fixer report accepted";

const nonblankTransportString = Type.String({ minLength: 1 });
const authorityBlockerSchema = Type.Object({ cause: Type.Literal("authority_violation"), evidence: nonblankTransportString });
const prerequisiteBlockerSchema = Type.Object({ cause: Type.Literal("prerequisite_unmet"), prerequisiteId: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }), evidence: nonblankTransportString });
const blockerSchema = Type.Union([authorityBlockerSchema, prerequisiteBlockerSchema]);
const exceptionSchema = Type.Object({ where: nonblankTransportString, reason: nonblankTransportString });
const completedClassResultSchema = Type.Object({
  name: nonblankTransportString,
  disposition: Type.Literal("completed"),
  searchScope: nonblankTransportString,
  exceptions: Type.Array(exceptionSchema),
  commitSha: nonblankTransportString,
});
const refusedClassResultSchema = Type.Object({
  name: nonblankTransportString,
  disposition: Type.Literal("refused"),
  remainingScope: nonblankTransportString,
  blocker: blockerSchema,
});
const classResultSchema = Type.Union([completedClassResultSchema, refusedClassResultSchema]);
const completedClassResultsSchema = Type.Array(completedClassResultSchema, { minItems: 1 });

const fixerOutputVariants = Type.Union([
  Type.Object({ status: Type.Literal("planned", { description: "Plan-phase proposal outcome." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }) }),
  Type.Object({ status: Type.Literal("refused", { description: "Lawfully refused outcome." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }), remainingScope: Type.String({ minLength: 1, description: "Work that cannot lawfully be performed." }), blocker: Type.Unsafe({ ...blockerSchema, description: "Lawful blocker preventing completion." }) }),
  Type.Object({ status: Type.Literal("unfinished", { description: "Honest unfinished apply outcome." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }), remainingScope: Type.String({ minLength: 1, description: "Work remaining after this invocation." }), classResults: Type.Optional(Type.Unsafe({ ...completedClassResultsSchema, description: "Completed class settlements from this invocation." })) }),
  Type.Object({ status: Type.Literal("completed", { description: "All assigned classes completed." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "Completed class settlements." }) }),
  Type.Object({ status: Type.Literal("refused", { description: "All assigned classes lawfully refused." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "Per-class refusal settlements." }) }),
  Type.Object({ status: Type.Literal("partially_completed", { description: "Assigned classes include completions and lawful refusals." }), report: Type.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "Per-class completion or refusal settlements." }) }),
]);
export const fixerOutputSchema = openToolObjectFromUnion(fixerOutputVariants);

export type FixerBlocker = Static<typeof blockerSchema>;
export type FixerClassResult = Static<typeof classResultSchema>;
export type FixerOutput = Static<typeof fixerOutputVariants>;
export type FixerPhase = "plan" | "apply";

export function validateFixerOutput(value: unknown, _phase?: FixerPhase): FixerOutput {
  return value as FixerOutput;
}

function safeProperty(value: unknown, property: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

/** Bind recognizable prerequisite blockers to the packet declaration. */
export function validateFixerOutputForPacket(value: unknown, phase: FixerPhase, packet: FixerInvocationInput): FixerOutput {
  const output = validateFixerOutput(value, phase);
  const declaredIds = new Set(packet.prerequisites.map((entry) => entry.id));
  const topLevelBlocker = safeProperty(output, "blocker");
  const classResults = safeProperty(output, "classResults");
  const blockers = topLevelBlocker === undefined
    ? (Array.isArray(classResults) ? classResults.map((entry) => safeProperty(entry, "blocker")) : [])
    : [topLevelBlocker];
  for (const blocker of blockers) {
    if (safeProperty(blocker, "cause") !== "prerequisite_unmet") continue;
    const prerequisiteId = safeProperty(blocker, "prerequisiteId");
    if (typeof prerequisiteId === "string" && !declaredIds.has(prerequisiteId)) {
      throw new Error("Fixer output violates blocker.prerequisiteId declared-prerequisite constraint");
    }
  }
  return output;
}
