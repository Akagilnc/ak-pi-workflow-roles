import { acceptedTextFor, carriesPackageAuditObservation, COLLECTOR_OUTPUT_TOOL, deepEqual, isTerminatingToolName, validateAcceptedDetails, type AcceptedDetails, type TerminatingToolName } from "../package-contracts/terminating-tools.ts";
import type { CollectorReceipt, JudgeVerdict, ReviewerOutput, WorkerOutput } from "../package-contracts/terminating-tools.ts";
import { RecorderError } from "./errors.ts";
import { combineReports, scanJsonValue, type ScanReport } from "./scanner.ts";

export type AcceptedReceipt = { toolName: TerminatingToolName; toolCallId: string; details: WorkerOutput | ReviewerOutput | JudgeVerdict | CollectorReceipt; kind: "worker" | "reviewer" | "judge" | "collector" };
export type AuditObservation = { toolName: "ak_judge_output" | "ak_reviewer_output"; toolCallId: string; auditPassed: true; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
export type ExtractionResult = { receipt: AcceptedReceipt; auditObservation: AuditObservation | null; artifactKind: "acceptedReceipt" | "sanitizedDerivativeOfAcceptedReceipt"; report: ScanReport };
const empty: ScanReport = { hits: [], redacted: false };
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));

function collectorProjection(args: unknown, details: unknown): boolean {
  if (!record(args) || !exact(args,["legs"]) || !Array.isArray(args.legs) || !record(details) || !Array.isArray(details.legs)) return false;
  const projected = details.legs.map(leg => { if (!record(leg)) return leg; const { unavailableScope: _drop, ...rest } = leg; return rest; });
  return deepEqual(args.legs, projected);
}
function usageOf(value: unknown): AuditObservation["usage"] | undefined {
  if (!record(value)) return undefined; const out: NonNullable<AuditObservation["usage"]> = {};
  for (const key of ["input","output","cacheRead","cacheWrite","totalTokens"] as const) { const n=value[key]; if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key]=n; }
  return Object.keys(out).length ? out : undefined;
}
function kind(name: TerminatingToolName): AcceptedReceipt["kind"] { return name === "ak_collector_output" ? "collector" : name === "ak_judge_output" ? "judge" : name === "ak_reviewer_output" ? "reviewer" : "worker"; }

/** Bind the closed direct Pi-v3 package lifecycle from already validated session rows. */
export function extractAcceptedReceipt(rows: unknown[]): ExtractionResult {
  const packageOccurrences: Array<{ i:number; role:"issue"|"result"; id:string; name:TerminatingToolName; args?:unknown; result?:Record<string,unknown> }> = [];
  for (let i=0;i<rows.length;i++) { const row=rows[i]; if (!record(row) || row.type !== "message" || !record(row.message)) continue; const m=row.message;
    if (m.role === "assistant" && Array.isArray(m.content)) for (const p of m.content) if (record(p) && p.type === "toolCall" && typeof p.name === "string" && isTerminatingToolName(p.name)) {
      if (!exact(p,["type","id","name","arguments"]) || typeof p.id !== "string" || !p.id) throw new RecorderError("acceptance-invalid");
      packageOccurrences.push({i,role:"issue",id:p.id,name:p.name,args:p.arguments});
    }
    if (m.role === "toolResult" && typeof m.toolName === "string" && isTerminatingToolName(m.toolName)) {
      if (typeof m.toolCallId !== "string" || !m.toolCallId) throw new RecorderError("acceptance-invalid");
      packageOccurrences.push({i,role:"result",id:m.toolCallId,name:m.toolName,result:m});
    }
  }
  if (!packageOccurrences.length) throw new RecorderError("acceptance-missing");
  const used=new Set<string>(); let accepted: typeof packageOccurrences[number] | null=null; let acceptedIssue: typeof packageOccurrences[number] | null=null;
  for (let p=0;p<packageOccurrences.length;) { const issue=packageOccurrences[p], result=packageOccurrences[p+1];
    if (!issue || !result || issue.role!=="issue" || result.role!=="result" || result.i!==issue.i+1 || issue.id!==result.id || issue.name!==result.name || used.has(issue.id)) throw new RecorderError("acceptance-invalid");
    used.add(issue.id); const issueRow=rows[issue.i] as Record<string,unknown>, resultRow=rows[result.i] as Record<string,unknown>;
    const issueMessage=issueRow.message as Record<string,unknown>, m=result.result!;
    if (!exact(issueRow,["type","id","parentId","timestamp","message"]) || !exact(resultRow,["type","id","parentId","timestamp","message"]) || resultRow.parentId!==issueRow.id || !exact(issueMessage,["role","content","stopReason","timestamp"]) || issueMessage.role!=="assistant" || issueMessage.stopReason!=="toolUse" || typeof issueMessage.timestamp!=="number" || !Array.isArray(issueMessage.content) || issueMessage.content.length!==1 || !exact(m,["role","toolCallId","toolName","content","isError","details"],["timestamp","usage"]) || m.role!=="toolResult") throw new RecorderError("acceptance-invalid");
    if (m.isError === true) { p+=2; continue; }
    if (m.isError !== false || accepted) throw new RecorderError("acceptance-invalid"); accepted=result; acceptedIssue=issue; p+=2;
  }
  if (!accepted || !acceptedIssue) throw new RecorderError("acceptance-missing");
  if (accepted.i !== rows.length-1 || acceptedIssue.i !== rows.length-2) throw new RecorderError("acceptance-invalid");
  const resultRow=rows[accepted.i] as Record<string,unknown>; if (!exact(resultRow,["type","id","parentId","timestamp","message"])) throw new RecorderError("acceptance-invalid");
  const m=accepted.result!; if (!exact(m,["role","toolCallId","toolName","content","isError","details"],["timestamp","usage"]) || m.role!=="toolResult" || (Object.hasOwn(m,"timestamp") && typeof m.timestamp!=="number") || !Array.isArray(m.content) || m.content.length!==1 || !record(m.content[0]) || !exact(m.content[0],["type","text"]) || m.content[0].type!=="text" || m.content[0].text!==acceptedTextFor(accepted.name)) throw new RecorderError("acceptance-invalid");
  const issueRow=rows[acceptedIssue.i] as Record<string,unknown>, im=(issueRow.message as Record<string,unknown>);
  if (!exact(issueRow,["type","id","parentId","timestamp","message"]) || !exact(im,["role","content","stopReason","timestamp"]) || im.role!=="assistant" || im.stopReason!=="toolUse" || typeof im.timestamp!=="number" || !Array.isArray(im.content) || im.content.length!==1) throw new RecorderError("acceptance-invalid");
  if (accepted.name===COLLECTOR_OUTPUT_TOOL ? !collectorProjection(acceptedIssue.args,m.details) : !deepEqual(acceptedIssue.args,m.details)) throw new RecorderError("acceptance-invalid");
  let details: AcceptedDetails; try { details=validateAcceptedDetails(accepted.name,m.details); } catch { throw new RecorderError("acceptance-invalid"); }
  const raw={toolName:accepted.name,toolCallId:accepted.id,details}; const scanned=scanJsonValue(raw,"receipt") as {value:typeof raw;report:ScanReport};
  try { validateAcceptedDetails(accepted.name,scanned.value.details); } catch { throw new RecorderError("scan-failed"); }
  const receipt: AcceptedReceipt={...scanned.value,kind:kind(accepted.name)};
  let auditObservation: AuditObservation|null=null; let report=scanned.report;
  if (carriesPackageAuditObservation(accepted.name)) { const usage=usageOf(m.usage); auditObservation={toolName:accepted.name,toolCallId:accepted.id,auditPassed:true,...(usage?{usage}:{})} as AuditObservation; if(usage) report=combineReports(report,scanJsonValue(usage,"audit.usage").report); }
  return {receipt,auditObservation,artifactKind:JSON.stringify(raw)===JSON.stringify(scanned.value)?"acceptedReceipt":"sanitizedDerivativeOfAcceptedReceipt",report:report??empty};
}
