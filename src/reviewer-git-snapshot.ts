export const REVIEW_REF_PREFIXES = ["refs/heads", "refs/tags", "refs/remotes"] as const;

/** Closed identity for a ref: annotated tags retain both tag object and peeled commit. */
export type ReviewerRefEntry = Readonly<{
  objectId: string;
  peeledCommitId: string;
}>;
export type ReviewerRefMap = Readonly<Record<string, ReviewerRefEntry>>;

export function parseReviewerRefSnapshot(raw: string): Record<string, ReviewerRefEntry> {
  const refs: Record<string, ReviewerRefEntry> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const fields = line.split("\0");
    if (fields.length !== 3 || !fields[0] || !fields[1]) {
      throw new Error(`Malformed Git ref snapshot line: ${line}`);
    }
    refs[fields[0]] = Object.freeze({
      objectId: fields[1],
      peeledCommitId: fields[2] || fields[1],
    });
  }
  return refs;
}

export function reviewerRefSnapshotArgs(): string[] {
  return ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", ...REVIEW_REF_PREFIXES];
}

export function immutableReviewerRefs(refs: ReviewerRefMap): ReviewerRefMap {
  return Object.freeze(Object.fromEntries(Object.entries(refs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => [name, Object.freeze({ objectId: entry.objectId, peeledCommitId: entry.peeledCommitId })])));
}

export function sameReviewerRefs(actual: ReviewerRefMap, expected: ReviewerRefMap): boolean {
  const a = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const b = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return a.length === b.length && a.every(([name, value], index) =>
    name === b[index]?.[0] && value.objectId === b[index]?.[1].objectId &&
    value.peeledCommitId === b[index]?.[1].peeledCommitId);
}
