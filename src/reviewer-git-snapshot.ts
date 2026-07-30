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

export function immutableReviewerRefs(refs: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b))));
}

export function sameReviewerRefs(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const a = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const b = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return a.length === b.length && a.every(([name, value], index) => name === b[index]?.[0] && value === b[index]?.[1]);
}
