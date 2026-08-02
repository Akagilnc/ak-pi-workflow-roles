import { Type } from "typebox";
import { Value } from "typebox/value";
export const FIXER_PREREQUISITE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
export const fixerPrerequisiteSchema = Type.Object({
    id: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
    requirement: Type.String({ pattern: "\\S" }),
}, { additionalProperties: false });
export const fixerPrerequisitesSchema = Type.Array(fixerPrerequisiteSchema);
function parseFailure(value) {
    if (!Array.isArray(value))
        throw new Error("Fixer prerequisites must be a JSON array");
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            throw new Error("Fixer prerequisite entry must be an object with id and requirement fields");
        const keys = Object.keys(entry);
        if (keys.length !== 2 || !keys.includes("id") || !keys.includes("requirement"))
            throw new Error("Fixer prerequisite entry fields must be exactly id and requirement");
        if (typeof entry.id !== "string" || !(new RegExp(FIXER_PREREQUISITE_ID_PATTERN)).test(entry.id))
            throw new Error(`Fixer prerequisite id violates pattern ${FIXER_PREREQUISITE_ID_PATTERN}`);
        if (typeof entry.requirement !== "string" || !/\S/.test(entry.requirement))
            throw new Error("Fixer prerequisite requirement must be nonblank");
    }
    throw new Error("Fixer prerequisites violate the attachment schema");
}
export function validateFixerPrerequisites(value) {
    if (!Value.Check(fixerPrerequisitesSchema, value))
        parseFailure(value);
    const entries = value;
    const ids = new Set();
    const prerequisites = entries.map((entry) => {
        if (ids.has(entry.id))
            throw new Error(`Fixer prerequisites contain duplicate id: ${entry.id}`);
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
    catch {
        throw new Error("Fixer prerequisites must contain valid JSON");
    }
    return validateFixerPrerequisites(decoded);
}
