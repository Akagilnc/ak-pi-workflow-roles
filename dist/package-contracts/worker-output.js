/** Package-owned worker (Coder/Fixer) output leaf — no role registration surface. */
export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const CODER_ACCEPTED_TEXT = "Coder report accepted";
export const FIXER_ACCEPTED_TEXT = "Fixer report accepted";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function validClassesRepaired(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const names = new Set();
    return value.every((entry) => {
        if (!isRecord(entry) || !hasExactKeys(entry, ["name", "searchScope", "exceptions"]) ||
            typeof entry.name !== "string" || entry.name.trim().length === 0 || entry.name.includes(",") ||
            typeof entry.searchScope !== "string" || entry.searchScope.trim().length === 0 ||
            !Array.isArray(entry.exceptions) || names.has(entry.name))
            return false;
        names.add(entry.name);
        return entry.exceptions.every((exception) => isRecord(exception) &&
            hasExactKeys(exception, ["where", "reason"]) &&
            typeof exception.where === "string" && exception.where.trim().length > 0 &&
            typeof exception.reason === "string" && exception.reason.trim().length > 0);
    });
}
/** Structural production validator for already-accepted worker tool details. */
export function validateAcceptedWorkerDetails(output, roleLabel = "Coder") {
    if (!isRecord(output))
        throw new Error(`${roleLabel} output must be an object`);
    const hasClasses = output.classesRepaired !== undefined;
    const expectedKeys = ["status", "report",
        ...(output.commitSha === undefined ? [] : ["commitSha"]),
        ...(hasClasses ? ["classesRepaired"] : [])];
    if (!hasExactKeys(output, expectedKeys) ||
        (output.status !== "planned" && output.status !== "completed" && output.status !== "refused") ||
        typeof output.report !== "string" || output.report.trim().length === 0 ||
        (output.commitSha !== undefined && (typeof output.commitSha !== "string" || output.commitSha.trim().length === 0))) {
        throw new Error(`${roleLabel} output requires planned|completed|refused, a non-blank report, and an optional non-blank commitSha`);
    }
    if (output.status === "planned" && output.commitSha !== undefined) {
        throw new Error(`${roleLabel} planned output forbids commitSha`);
    }
    if (hasClasses && (roleLabel !== "Fixer" || output.status !== "completed" || !validClassesRepaired(output.classesRepaired))) {
        throw new Error(`${roleLabel} classesRepaired is Fixer-completed-only and requires unique comma-free class names`);
    }
    return {
        status: output.status,
        report: output.report,
        ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }),
        ...(hasClasses ? { classesRepaired: output.classesRepaired.map((entry) => ({
                ...entry, exceptions: entry.exceptions.map((exception) => ({ ...exception })),
            })) } : {}),
    };
}
