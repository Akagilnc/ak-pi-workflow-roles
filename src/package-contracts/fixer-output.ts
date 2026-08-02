import { Type, type Static } from "typebox";
import { FIXER_PREREQUISITE_ID_PATTERN, type FixPacketV1 } from "./fixer-packet.ts";

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

export const fixerOutputSchema = Type.Union([
  Type.Object({ status: Type.Literal("planned"), report: nonblankTransportString }),
  Type.Object({ status: Type.Literal("refused"), report: nonblankTransportString, remainingScope: nonblankTransportString, blocker: blockerSchema }),
  Type.Object({ status: Type.Literal("completed"), report: nonblankTransportString, classResults: Type.Array(classResultSchema, { minItems: 1 }) }),
  Type.Object({ status: Type.Literal("refused"), report: nonblankTransportString, classResults: Type.Array(classResultSchema, { minItems: 1 }) }),
  Type.Object({ status: Type.Literal("partially_completed"), report: nonblankTransportString, classResults: Type.Array(classResultSchema, { minItems: 1 }) }),
]);

export type FixerBlocker = Static<typeof blockerSchema>;
export type FixerClassResult = Static<typeof classResultSchema>;
export type FixerOutput = Static<typeof fixerOutputSchema>;
export type FixerPhase = "plan" | "apply";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function fail(constraint: string): never { throw new Error(`Fixer output violates ${constraint}`); }
function blocker(value: unknown, path: string): FixerBlocker {
  if (!record(value)) fail(`${path} object constraint`);
  if (!nonblank(value.evidence)) fail(`${path}.evidence nonblank constraint`);
  if (value.cause === "authority_violation") return { cause: "authority_violation", evidence: value.evidence };
  if (value.cause === "prerequisite_unmet") {
    if (typeof value.prerequisiteId !== "string" || !new RegExp(FIXER_PREREQUISITE_ID_PATTERN).test(value.prerequisiteId)) fail(`${path}.prerequisiteId pattern constraint`);
    return { cause: "prerequisite_unmet", prerequisiteId: value.prerequisiteId, evidence: value.evidence };
  }
  fail(`${path}.cause allowed-values constraint`);
}

export function validateFixerOutput(value: unknown, phase?: FixerPhase): FixerOutput {
  if (!record(value)) fail("root object constraint");
  if (!nonblank(value.report)) fail("report nonblank constraint");
  if (value.status === "planned") {
    if (phase === "apply") fail("status phase constraint: apply forbids planned");
    if (Object.hasOwn(value, "classResults") || Object.hasOwn(value, "remainingScope") || Object.hasOwn(value, "blocker") || Object.hasOwn(value, "commitSha")) fail("status planned semantic-field combination constraint");
    return { status: "planned", report: value.report };
  }
  if (value.status === "refused" && Object.hasOwn(value, "remainingScope")) {
    if (phase === "apply") fail("status phase constraint: apply refusal requires classResults");
    if (!nonblank(value.remainingScope)) fail("remainingScope nonblank constraint");
    return { status: "refused", report: value.report, remainingScope: value.remainingScope, blocker: blocker(value.blocker, "blocker") };
  }
  if (phase === "plan") fail("status phase constraint: plan permits planned or refused");
  if (value.status !== "completed" && value.status !== "refused" && value.status !== "partially_completed") fail("status allowed-values constraint");
  if (!Array.isArray(value.classResults) || value.classResults.length === 0) fail("classResults nonempty array constraint");
  const names = new Set<string>(), commits = new Set<string>();
  let completed = 0, refused = 0;
  const classResults: FixerClassResult[] = value.classResults.map((item, index) => {
    const path = `classResults[${index}]`;
    if (!record(item)) fail(`${path} object constraint`);
    if (!nonblank(item.name)) fail(`${path}.name nonblank constraint`);
    if (names.has(item.name)) fail("classResults name unique constraint");
    names.add(item.name);
    if (item.disposition === "completed") {
      if (!nonblank(item.searchScope)) fail(`${path}.searchScope nonblank constraint`);
      if (!Array.isArray(item.exceptions)) fail(`${path}.exceptions array constraint`);
      const exceptions = item.exceptions.map((entry, exceptionIndex) => {
        const exceptionPath = `${path}.exceptions[${exceptionIndex}]`;
        if (!record(entry)) fail(`${exceptionPath} object constraint`);
        if (!nonblank(entry.where)) fail(`${exceptionPath}.where nonblank constraint`);
        if (!nonblank(entry.reason)) fail(`${exceptionPath}.reason nonblank constraint`);
        return { where: entry.where, reason: entry.reason };
      });
      if (!nonblank(item.commitSha)) fail(`${path}.commitSha nonblank constraint`);
      if (commits.has(item.commitSha)) fail("classResults completed commitSha distinct constraint");
      commits.add(item.commitSha); completed++;
      return { name: item.name, disposition: "completed", searchScope: item.searchScope, exceptions, commitSha: item.commitSha };
    }
    if (item.disposition === "refused") {
      if (!nonblank(item.remainingScope)) fail(`${path}.remainingScope nonblank constraint`);
      refused++;
      return { name: item.name, disposition: "refused", remainingScope: item.remainingScope, blocker: blocker(item.blocker, `${path}.blocker`) };
    }
    fail(`${path}.disposition allowed-values constraint`);
  });
  if (value.status === "completed" && (refused !== 0 || completed === 0)) fail("status completed disposition combination constraint");
  if (value.status === "refused" && (completed !== 0 || refused === 0)) fail("status refused disposition combination constraint");
  if (value.status === "partially_completed" && (completed === 0 || refused === 0)) fail("status partially_completed disposition combination constraint");
  return { status: value.status, report: value.report, classResults } as FixerOutput;
}

export function validateFixerOutputForPacket(value: unknown, phase: FixerPhase, packet: FixPacketV1): FixerOutput {
  const output = validateFixerOutput(value, phase);
  const declaredIds = new Set(packet.prerequisites.map((entry) => entry.id));
  const blockers: FixerBlocker[] = "blocker" in output ? [output.blocker] : "classResults" in output ? output.classResults.filter((entry) => entry.disposition === "refused").map((entry) => entry.blocker) : [];
  if (blockers.some((entry) => entry.cause === "prerequisite_unmet" && !declaredIds.has(entry.prerequisiteId))) fail("blocker.prerequisiteId declared-in-packet constraint");
  return output;
}
