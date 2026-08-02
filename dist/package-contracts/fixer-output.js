import { Type } from "typebox";
import { FIXER_PREREQUISITE_ID_PATTERN } from "./fixer-packet.js";
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
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
function fail(constraint) { throw new Error(`Fixer output violates ${constraint}`); }
function blocker(value, path) {
    if (!record(value))
        fail(`${path} object constraint`);
    if (!nonblank(value.evidence))
        fail(`${path}.evidence nonblank constraint`);
    if (value.cause === "authority_violation") {
        if (Object.hasOwn(value, "prerequisiteId"))
            fail(`${path} authority_violation prerequisiteId semantic-field constraint`);
        return { cause: "authority_violation", evidence: value.evidence };
    }
    if (value.cause === "prerequisite_unmet") {
        if (typeof value.prerequisiteId !== "string" || !new RegExp(FIXER_PREREQUISITE_ID_PATTERN).test(value.prerequisiteId))
            fail(`${path}.prerequisiteId pattern constraint`);
        return { cause: "prerequisite_unmet", prerequisiteId: value.prerequisiteId, evidence: value.evidence };
    }
    fail(`${path}.cause allowed-values constraint`);
}
export function validateFixerOutput(value, phase) {
    if (!record(value))
        fail("root object constraint");
    if (!nonblank(value.report))
        fail("report nonblank constraint");
    if (Object.hasOwn(value, "commitSha") || Object.hasOwn(value, "classesRepaired"))
        fail("removed top-level commit semantic-field constraint");
    if (value.status === "planned") {
        if (phase === "apply")
            fail("status phase constraint: apply forbids planned");
        if (Object.hasOwn(value, "classResults") || Object.hasOwn(value, "remainingScope") || Object.hasOwn(value, "blocker") || Object.hasOwn(value, "commitSha"))
            fail("status planned semantic-field combination constraint");
        return { status: "planned", report: value.report };
    }
    if (value.status === "refused" && Object.hasOwn(value, "remainingScope")) {
        if (Object.hasOwn(value, "classResults"))
            fail("status refused plan/apply semantic-field combination constraint");
        if (phase === "apply")
            fail("status phase constraint: apply refusal requires classResults");
        if (!nonblank(value.remainingScope))
            fail("remainingScope nonblank constraint");
        return { status: "refused", report: value.report, remainingScope: value.remainingScope, blocker: blocker(value.blocker, "blocker") };
    }
    if (phase === "plan")
        fail("status phase constraint: plan permits planned or refused");
    if (value.status !== "completed" && value.status !== "refused" && value.status !== "partially_completed")
        fail("status allowed-values constraint");
    if (!Array.isArray(value.classResults) || value.classResults.length === 0)
        fail("classResults nonempty array constraint");
    const names = new Set(), commits = new Set();
    let completed = 0, refused = 0;
    const classResults = value.classResults.map((item, index) => {
        const path = `classResults[${index}]`;
        if (!record(item))
            fail(`${path} object constraint`);
        if (!nonblank(item.name))
            fail(`${path}.name nonblank constraint`);
        if (names.has(item.name))
            fail("classResults name unique constraint");
        names.add(item.name);
        if (item.disposition === "completed") {
            if (Object.hasOwn(item, "remainingScope") || Object.hasOwn(item, "blocker"))
                fail(`${path} completed/refused semantic-field combination constraint`);
            if (!nonblank(item.searchScope))
                fail(`${path}.searchScope nonblank constraint`);
            if (!Array.isArray(item.exceptions))
                fail(`${path}.exceptions array constraint`);
            const exceptions = item.exceptions.map((entry, exceptionIndex) => {
                const exceptionPath = `${path}.exceptions[${exceptionIndex}]`;
                if (!record(entry))
                    fail(`${exceptionPath} object constraint`);
                if (!nonblank(entry.where))
                    fail(`${exceptionPath}.where nonblank constraint`);
                if (!nonblank(entry.reason))
                    fail(`${exceptionPath}.reason nonblank constraint`);
                return { where: entry.where, reason: entry.reason };
            });
            if (!nonblank(item.commitSha))
                fail(`${path}.commitSha nonblank constraint`);
            if (commits.has(item.commitSha))
                fail("classResults completed commitSha distinct constraint");
            commits.add(item.commitSha);
            completed++;
            return { name: item.name, disposition: "completed", searchScope: item.searchScope, exceptions, commitSha: item.commitSha };
        }
        if (item.disposition === "refused") {
            if (Object.hasOwn(item, "searchScope") || Object.hasOwn(item, "exceptions") || Object.hasOwn(item, "commitSha"))
                fail(`${path} refused/completed semantic-field combination constraint`);
            if (!nonblank(item.remainingScope))
                fail(`${path}.remainingScope nonblank constraint`);
            refused++;
            return { name: item.name, disposition: "refused", remainingScope: item.remainingScope, blocker: blocker(item.blocker, `${path}.blocker`) };
        }
        fail(`${path}.disposition allowed-values constraint`);
    });
    if (value.status === "completed" && (refused !== 0 || completed === 0))
        fail("status completed disposition combination constraint");
    if (value.status === "refused" && (completed !== 0 || refused === 0))
        fail("status refused disposition combination constraint");
    if (value.status === "partially_completed" && (completed === 0 || refused === 0))
        fail("status partially_completed disposition combination constraint");
    return { status: value.status, report: value.report, classResults };
}
/** Prerequisite-aware admission used after structural/phase validation and before audit. */
export function validateFixerOutputForPacket(value, phase, packet) {
    const output = validateFixerOutput(value, phase);
    const declaredIds = new Set(packet.prerequisites.map((entry) => entry.id));
    const blockers = "blocker" in output
        ? [output.blocker]
        : "classResults" in output
            ? output.classResults.filter((entry) => entry.disposition === "refused").map((entry) => entry.blocker)
            : [];
    if (blockers.some((entry) => entry.cause === "prerequisite_unmet" && !declaredIds.has(entry.prerequisiteId))) {
        fail("blocker.prerequisiteId declared-prerequisite constraint");
    }
    return output;
}
