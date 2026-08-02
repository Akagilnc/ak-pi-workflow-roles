import { Type } from "typebox";
import { FIXER_PREREQUISITE_ID_PATTERN } from "./fixer-packet.js";
export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const FIXER_ACCEPTED_TEXT = "Fixer report accepted";
const nonblankTransportString = Type.String({ minLength: 1 });
const authorityBlockerSchema = Type.Object({
    cause: Type.Literal("authority_violation"),
    evidence: nonblankTransportString,
}, { additionalProperties: false });
const prerequisiteBlockerSchema = Type.Object({
    cause: Type.Literal("prerequisite_unmet"),
    prerequisiteId: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
    evidence: nonblankTransportString,
}, { additionalProperties: false });
const blockerSchema = Type.Union([authorityBlockerSchema, prerequisiteBlockerSchema]);
const exceptionSchema = Type.Object({
    where: nonblankTransportString,
    reason: nonblankTransportString,
}, { additionalProperties: false });
const completedClassResultSchema = Type.Object({
    name: nonblankTransportString,
    disposition: Type.Literal("completed"),
    searchScope: nonblankTransportString,
    exceptions: Type.Array(exceptionSchema),
    commitSha: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
}, { additionalProperties: false });
const refusedClassResultSchema = Type.Object({
    name: nonblankTransportString,
    disposition: Type.Literal("refused"),
    remainingScope: nonblankTransportString,
    blocker: blockerSchema,
}, { additionalProperties: false });
const classResultSchema = Type.Union([completedClassResultSchema, refusedClassResultSchema]);
export const fixerOutputSchema = Type.Union([
    Type.Object({ status: Type.Literal("planned"), report: nonblankTransportString }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("refused"), report: nonblankTransportString,
        remainingScope: nonblankTransportString, blocker: blockerSchema,
    }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("completed"), report: nonblankTransportString,
        classResults: Type.Array(classResultSchema, { minItems: 1 }),
    }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("refused"), report: nonblankTransportString,
        classResults: Type.Array(classResultSchema, { minItems: 1 }),
    }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("partially_completed"), report: nonblankTransportString,
        classResults: Type.Array(classResultSchema, { minItems: 1 }),
    }, { additionalProperties: false }),
]);
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
const validBlocker = (value) => record(value) && nonblank(value.evidence) && ((value.cause === "authority_violation" && exact(value, ["cause", "evidence"])) ||
    (value.cause === "prerequisite_unmet" && exact(value, ["cause", "prerequisiteId", "evidence"]) &&
        typeof value.prerequisiteId === "string" && new RegExp(FIXER_PREREQUISITE_ID_PATTERN).test(value.prerequisiteId)));
const validException = (value) => record(value) && exact(value, ["where", "reason"]) && nonblank(value.where) && nonblank(value.reason);
function fail() { throw new Error("Fixer output violates the exact phase settlement contract"); }
export function validateFixerOutput(value, phase) {
    if (!record(value) || !nonblank(value.report))
        fail();
    if (value.status === "planned") {
        if (phase === "apply" || !exact(value, ["status", "report"]))
            fail();
        return { status: "planned", report: value.report };
    }
    if (value.status === "refused" && exact(value, ["status", "report", "remainingScope", "blocker"])) {
        if (phase === "apply" || !nonblank(value.remainingScope) || !validBlocker(value.blocker))
            fail();
        return { status: "refused", report: value.report, remainingScope: value.remainingScope, blocker: { ...value.blocker } };
    }
    if (phase === "plan")
        fail();
    if ((value.status !== "completed" && value.status !== "refused" && value.status !== "partially_completed") ||
        !exact(value, ["status", "report", "classResults"]) || !Array.isArray(value.classResults) || value.classResults.length === 0)
        fail();
    const names = new Set();
    const commits = new Set();
    let completed = 0;
    let refused = 0;
    const classResults = value.classResults.map((item) => {
        if (!record(item) || !nonblank(item.name) || item.name.includes(",") || names.has(item.name))
            fail();
        names.add(item.name);
        if (item.disposition === "completed") {
            if (!exact(item, ["name", "disposition", "searchScope", "exceptions", "commitSha"]) || !nonblank(item.searchScope) ||
                !Array.isArray(item.exceptions) || !item.exceptions.every(validException) || typeof item.commitSha !== "string" ||
                !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.commitSha) || commits.has(item.commitSha))
                fail();
            commits.add(item.commitSha);
            completed += 1;
            return { name: item.name, disposition: "completed", searchScope: item.searchScope, exceptions: item.exceptions.map((entry) => ({ where: entry.where, reason: entry.reason })), commitSha: item.commitSha };
        }
        if (item.disposition === "refused") {
            if (!exact(item, ["name", "disposition", "remainingScope", "blocker"]) || !nonblank(item.remainingScope) || !validBlocker(item.blocker))
                fail();
            refused += 1;
            return { name: item.name, disposition: "refused", remainingScope: item.remainingScope, blocker: { ...item.blocker } };
        }
        fail();
    });
    if ((value.status === "completed" && (refused !== 0 || completed === 0)) ||
        (value.status === "refused" && (completed !== 0 || refused === 0)) ||
        (value.status === "partially_completed" && (completed === 0 || refused === 0)))
        fail();
    return { status: value.status, report: value.report, classResults };
}
/** Packet-aware admission used after structural/phase validation and before audit. */
export function validateFixerOutputForPacket(value, phase, packet) {
    const output = validateFixerOutput(value, phase);
    const declaredIds = new Set(packet.prerequisites.map((entry) => entry.id));
    const blockers = "blocker" in output
        ? [output.blocker]
        : "classResults" in output
            ? output.classResults.filter((entry) => entry.disposition === "refused").map((entry) => entry.blocker)
            : [];
    if (blockers.some((blocker) => blocker.cause === "prerequisite_unmet" && !declaredIds.has(blocker.prerequisiteId))) {
        throw new Error("Fixer output prerequisiteId must name a declared prerequisite id");
    }
    return output;
}
