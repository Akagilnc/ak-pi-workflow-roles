export const REVIEW_REF_PREFIXES = ["refs/heads", "refs/tags", "refs/remotes"];
export function parseReviewerRefSnapshot(raw) {
    const refs = {};
    for (const line of raw.split("\n")) {
        if (!line)
            continue;
        const fields = line.split("\0");
        if (fields.length !== 5 || !fields[0] || !fields[1] || !fields[3]) {
            throw new Error(`Malformed Git ref snapshot line: ${line}`);
        }
        const peeledCommitId = fields[3] === "commit"
            ? fields[1]
            : fields[4] === "commit" && fields[2] ? fields[2] : null;
        refs[fields[0]] = Object.freeze({
            objectId: fields[1],
            peeledCommitId,
        });
    }
    return refs;
}
export function reviewerRefSnapshotArgs() {
    return ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)", ...REVIEW_REF_PREFIXES];
}
export function immutableReviewerRefs(refs) {
    return Object.freeze(Object.fromEntries(Object.entries(refs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, Object.freeze({ objectId: entry.objectId, peeledCommitId: entry.peeledCommitId })])));
}
export function sameReviewerPinnedTarget(actual, expected) {
    return actual.repositoryRoot === expected.repositoryRoot && actual.objectFormat === expected.objectFormat &&
        actual.targetHead === expected.targetHead;
}
