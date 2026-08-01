import { Type } from "typebox";
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
function fail() {
    throw new Error("FixPacketV1 violates the exact packet contract");
}
export function validateFixPacketV1(value) {
    if (!Value.Check(fixerPacketV1Schema, value))
        fail();
    const parsed = value;
    const ids = new Set();
    const prerequisites = parsed.prerequisites.map((entry) => {
        if (ids.has(entry.id))
            fail();
        ids.add(entry.id);
        return Object.freeze({ id: entry.id, requirement: entry.requirement });
    });
    return Object.freeze({
        version: 1,
        instructions: parsed.instructions,
        prerequisites: Object.freeze(prerequisites),
    });
}
export function parseFixPacketV1(source) {
    let decoded;
    try {
        decoded = JSON.parse(source);
    }
    catch {
        fail();
    }
    return validateFixPacketV1(decoded);
}
