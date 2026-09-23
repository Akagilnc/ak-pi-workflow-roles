/** Public argv that admits one active seat. Seat-only flags stay here. */
export function publicSeatSummonArgv(
  role: string,
  project: string,
  sourceRun: string,
  issueNumber: number,
): string[] {
  const common = ["--model", "test/caller-seat:high", "--project", project];
  switch (role) {
    case "gleaner-left":
      return [role, ...common, "--base", "HEAD", "note"];
    case "reviewer":
      return [
        role,
        ...common,
        "--base",
        "HEAD",
        "--lens",
        "completeness",
        "--authority-ref",
        "https://example.com/adr/0082",
        "review",
      ];
    case "doctor":
      return [role, ...common, "--issue", String(issueNumber), "case"];
    case "collector":
      return [role, ...common, "--repo", "Akagilnc/ak-pi-workflow-roles", "--pr", "1", "collect"];
    case "notary":
    case "auditor":
      return role === "auditor"
        ? [role, ...common, "--subject", "judge", "--source-run", sourceRun, "audit"]
        : [role, ...common, "--source-run", sourceRun];
    case "merger":
      return [role, ...common, "merge the current tree"];
    default:
      return [role, ...common, "known ticket summons"];
  }
}
