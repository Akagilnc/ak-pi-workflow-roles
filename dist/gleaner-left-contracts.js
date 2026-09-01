/**
 * Public Gleaner-Left (左拾遗) terminating receipt contracts.
 * Lawful explicit release: completed, with empty or nonempty 弹章.
 * No bounce / verdict channel (言不为狱). 原卷保真 (ADR 0055).
 */
export const GLEANER_LEFT_OUTPUT_TOOL_NAME = "ak_gleaner_left_output";
export const GLEANER_LEFT_ACCEPTED_TEXT = "左拾遗回执已接受";
/** Internal transport: comparison-base revision for the unanchored merge-candidate diff. */
export const GLEANER_LEFT_BASE_FLAG = {
    name: "ak-gleaner-left-base",
    definition: {
        description: "Fixed comparison-base revision for the unanchored merge-candidate diff",
        type: "string",
    },
};
export function validateRecordedGleanerLeftOutput(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Gleaner-left output has no execution discriminator");
    }
    let status;
    try {
        status = value.status;
    }
    catch {
        throw new Error("Gleaner-left output has no execution discriminator");
    }
    if (status === "completed") {
        return value;
    }
    throw new Error("Gleaner-left output has no execution discriminator");
}
/** Machine-facing facts from an accepted 弹章. Findings retained as submitted. */
export function gleanerLeftDecisiveFacts(output) {
    const facts = { status: output.status };
    const findings = output.findings;
    if (Array.isArray(findings))
        facts.findings = findings;
    return facts;
}
