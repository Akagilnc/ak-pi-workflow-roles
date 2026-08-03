/** Shared Fixer classResult factories for unit/contract tables. */

export const shaA = "a".repeat(40);
export const shaB = "b".repeat(64);

export const completed = (name = "ParserCase", commitSha = shaA) => ({
  name,
  disposition: "completed" as const,
  searchScope: "all parser entry points",
  exceptions: [{ where: "legacy adapter", reason: "already correct" }],
  commitSha,
});

export const refused = (name = "TransportCase") => ({
  name,
  disposition: "refused" as const,
  remainingScope: "provider-backed execution",
  blocker: {
    cause: "prerequisite_unmet" as const,
    prerequisiteId: "repository.ready",
    evidence: "required repository is absent",
  },
});
