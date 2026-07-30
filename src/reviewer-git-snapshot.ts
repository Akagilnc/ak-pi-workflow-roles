export const REVIEW_REF_PREFIXES = ["refs/heads", "refs/tags", "refs/remotes"] as const;

/** Parse the immutable, commit-peeled output requested by reviewerRefSnapshotArgs. */
export function parseReviewerRefSnapshot(raw: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const fields = line.split("\0");
    if (fields.length !== 3 || !fields[0] || !fields[1]) {
      throw new Error(`Malformed Git ref snapshot line: ${line}`);
    }
    refs[fields[0]] = fields[2] || fields[1];
  }
  return refs;
}

export function reviewerRefSnapshotArgs(): string[] {
  return [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)",
    ...REVIEW_REF_PREFIXES,
  ];
}
