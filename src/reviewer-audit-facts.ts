import type { ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
export type ReviewerAuditReadiness = Readonly<{ ready:boolean; missing:readonly string[] }>;
export function reviewerAuditReadiness(record:ReviewerExecutionRecord):ReviewerAuditReadiness {
  const missing:string[]=[];
  if(record.accepted!==undefined) for(const axis of ["standards","spec"] as const){const result=record.results[axis];if(result?.status==="successful"&&result.runtimeConstructionEvidence===undefined)missing.push(`${axis}: runtime construction evidence`)}
  return Object.freeze({ready:missing.length===0,missing:Object.freeze(missing)});
}
