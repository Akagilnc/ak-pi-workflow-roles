import { Type } from "typebox";
import { Value } from "typebox/value";
export const FIXER_PREREQUISITE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
export const fixerPrerequisiteSchema = Type.Object({
    id: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
    requirement: Type.String({ pattern: "\\S" }),
}, { additionalProperties: false });
export const fixerPrerequisitesSchema = Type.Array(fixerPrerequisiteSchema);
function causeMessage(cause) {
    if (cause instanceof Error)
        return cause.message;
    if (typeof cause === "string")
        return cause;
    try {
        return JSON.stringify(cause) ?? String(cause);
    }
    catch {
        return String(cause);
    }
}
export class FixerPacketValidationError extends Error {
    code = "AK_INVALID_FIX_PACKET";
    constructor(cause) {
        const prefix = "Fixer prerequisites or instructions violate the invocation contract";
        super(cause === undefined ? prefix : `${prefix}: ${causeMessage(cause)}`, cause === undefined ? undefined : { cause });
        this.name = "FixerPacketValidationError";
    }
}
function fail(cause) {
    throw new FixerPacketValidationError(cause);
}
function parseFailure(value) {
    if (!Array.isArray(value))
        fail(new Error("Fixer prerequisites must be a JSON array"));
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            fail(new Error("Fixer prerequisite entry must be an object with id and requirement fields"));
        }
        const keys = Object.keys(entry);
        if (keys.length !== 2 || !keys.includes("id") || !keys.includes("requirement")) {
            fail(new Error("Fixer prerequisite entry fields must be exactly id and requirement"));
        }
        if (typeof entry.id !== "string" ||
            !(new RegExp(FIXER_PREREQUISITE_ID_PATTERN)).test(entry.id)) {
            fail(new Error(`Fixer prerequisite id violates pattern ${FIXER_PREREQUISITE_ID_PATTERN}`));
        }
        if (typeof entry.requirement !== "string" ||
            !/\S/.test(entry.requirement)) {
            fail(new Error("Fixer prerequisite requirement must be nonblank"));
        }
    }
    fail(new Error("Fixer prerequisites violate the attachment schema"));
}
export function validateFixerPrerequisites(value) {
    if (!Value.Check(fixerPrerequisitesSchema, value))
        parseFailure(value);
    const entries = value;
    const ids = new Set();
    const prerequisites = entries.map((entry) => {
        if (ids.has(entry.id)) {
            fail(new Error(`Fixer prerequisites contain duplicate id: ${entry.id}`));
        }
        ids.add(entry.id);
        return Object.freeze({ id: entry.id, requirement: entry.requirement });
    });
    return Object.freeze(prerequisites);
}
export function parseFixerPrerequisites(source) {
    let decoded;
    try {
        decoded = JSON.parse(source);
    }
    catch (error) {
        fail(error);
    }
    return validateFixerPrerequisites(decoded);
}
