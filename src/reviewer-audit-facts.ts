import type { ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
export type ReviewerAuditReadiness = Readonly<{ ready: boolean; missing: readonly string[] }>;
export function reviewerAuditReadiness(record: ReviewerExecutionRecord): ReviewerAuditReadiness {
  const missing: string[] = [];
  if (record.accepted !== undefined) {
    for (const axis of ["standards", "spec"] as const) {
      const result = record.results[axis];
      if (result?.status === "successful" && (typeof result.report !== "string" || result.report.length === 0)) {
        missing.push(`${axis}: successful report`);
      }
    }
  }
  return Object.freeze({ ready: missing.length === 0, missing: Object.freeze(missing) });
}
