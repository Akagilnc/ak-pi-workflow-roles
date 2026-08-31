/**
 * Shared docs/adr path extraction from free text (issue body / ticket face).
 * Single authority for reviewer Spec discovery and diarist source enumeration.
 *
 * Shape only: segments under docs/adr/ without `..` or empty parts. Real IO
 * confinement still lives at the read seam (ADR 0038).
 */
/** docs/adr paths referenced inside free text (order of first appearance). */
// Each segment must start with alnum so `.` / `..` traversal claims never match.
const ADR_PATH_IN_BODY = /docs\/adr\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md/g;
/** Extract unique docs/adr/*.md paths; preserve first-seen order. */
export function extractReferencedAdrPaths(text) {
    const seen = new Set();
    const paths = [];
    for (const match of text.matchAll(ADR_PATH_IN_BODY)) {
        const path = match[0];
        if (seen.has(path))
            continue;
        seen.add(path);
        paths.push(path);
    }
    return Object.freeze(paths);
}
