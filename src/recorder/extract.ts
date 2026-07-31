import {
  carriesPackageAuditObservation,
  COLLECTOR_OUTPUT_TOOL,
  deepEqual,
  isTerminatingToolName,
  validateAcceptedDetails,
  type AcceptedDetails,
  type TerminatingToolName,
} from "../package-contracts/terminating-tools.ts";
import type { CollectorReceipt, JudgeVerdict, ReviewerOutput, WorkerOutput } from "../package-contracts/terminating-tools.ts";
import { RecorderError } from "./errors.ts";
import { combineReports, scanJsonValue, type ScanReport } from "./scanner.ts";

export type AcceptedReceipt = { toolName: TerminatingToolName; toolCallId: string; details: WorkerOutput | ReviewerOutput | JudgeVerdict | CollectorReceipt; kind: "worker" | "reviewer" | "judge" | "collector" };
export type AuditObservation = { toolName: "ak_judge_output" | "ak_reviewer_output"; toolCallId: string; auditPassed: true; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
export type ExtractionResult = { receipt: AcceptedReceipt; auditObservation: AuditObservation | null; artifactKind: "acceptedReceipt" | "sanitizedDerivativeOfAcceptedReceipt"; report: ScanReport };

type DirectIssuance = { index: number; rowId: unknown; toolCallId: string; toolName: TerminatingToolName; arguments: unknown };
type AcceptedPair = { issuance: DirectIssuance; resultIndex: number; resultMessage: Record<string, unknown> };

const emptyReport: ScanReport = { hits: [], redacted: false };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const invalid = (): never => { throw new RecorderError("acceptance-invalid"); };

function collectorProjection(argumentsValue: unknown, details: unknown): boolean {
  if (!isRecord(argumentsValue) || !hasExactKeys(argumentsValue, ["legs"]) || !Array.isArray(argumentsValue.legs) || !isRecord(details) || !Array.isArray(details.legs)) return false;
  const projected = details.legs.map((leg) => {
    if (!isRecord(leg)) return leg;
    const { unavailableScope: _omitted, ...rest } = leg;
    return rest;
  });
  return deepEqual(argumentsValue.legs, projected);
}

function usageOf(value: unknown): AuditObservation["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const usage: NonNullable<AuditObservation["usage"]> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function receiptKind(toolName: TerminatingToolName): AcceptedReceipt["kind"] {
  if (toolName === "ak_collector_output") return "collector";
  if (toolName === "ak_judge_output") return "judge";
  if (toolName === "ak_reviewer_output") return "reviewer";
  return "worker";
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], ["cacheWrite1h", "reasoning"])) return false;
  const counts = [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens];
  if (Object.hasOwn(value, "cacheWrite1h")) counts.push(value.cacheWrite1h);
  if (Object.hasOwn(value, "reasoning")) counts.push(value.reasoning);
  if (!counts.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0) || !isRecord(value.cost) ||
      !hasExactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])) return false;
  return Object.values(value.cost).every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0);
}

function validDiagnostics(value: unknown): boolean {
  return Array.isArray(value) && value.every((diagnostic) => isRecord(diagnostic) &&
    hasExactKeys(diagnostic, ["type", "timestamp"], ["error", "details"]) && typeof diagnostic.type === "string" &&
    typeof diagnostic.timestamp === "number" &&
    (!Object.hasOwn(diagnostic, "details") || isRecord(diagnostic.details)) &&
    (!Object.hasOwn(diagnostic, "error") || isRecord(diagnostic.error)));
}

function directIssuance(row: Record<string, unknown>, index: number): DirectIssuance | null {
  if (row.type !== "message" || !isRecord(row.message)) return null;
  const message = row.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const packageCalls = message.content.filter((part) => isRecord(part) && typeof part.name === "string" && isTerminatingToolName(part.name));
  if (!packageCalls.length) return null;
  if (!hasExactKeys(row, ["type", "id", "parentId", "timestamp", "message"]) ||
      !hasExactKeys(message, ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"], ["responseModel", "responseId", "diagnostics", "errorMessage", "rawStopReason"]) ||
      message.stopReason !== "toolUse" || typeof message.timestamp !== "number" ||
      typeof message.api !== "string" || !message.api || typeof message.provider !== "string" || !message.provider ||
      typeof message.model !== "string" || !message.model || !validUsage(message.usage) ||
      (["responseModel", "responseId", "errorMessage", "rawStopReason"].some((key) => Object.hasOwn(message, key) && typeof message[key] !== "string")) ||
      (Object.hasOwn(message, "diagnostics") && !validDiagnostics(message.diagnostics))) invalid();
  let call: Record<string, unknown> | null = null;
  for (const part of message.content) {
    if (!isRecord(part)) invalid();
    if (part.type === "thinking") {
      if (!hasExactKeys(part, ["type", "thinking"], ["thinkingSignature", "redacted"]) || typeof part.thinking !== "string" ||
          (Object.hasOwn(part, "thinkingSignature") && typeof part.thinkingSignature !== "string") ||
          (Object.hasOwn(part, "redacted") && typeof part.redacted !== "boolean")) invalid();
      continue;
    }
    if (part.type !== "toolCall" || call) invalid();
    call = part;
  }
  if (!call || packageCalls.length !== 1 || !hasExactKeys(call, ["type", "id", "name", "arguments"], ["thoughtSignature"]) ||
      typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !isTerminatingToolName(call.name) || !isRecord(call.arguments) ||
      (Object.hasOwn(call, "thoughtSignature") && typeof call.thoughtSignature !== "string")) invalid();
  const admittedCall = call as Record<string, unknown> & { id: string; name: TerminatingToolName; arguments: Record<string, unknown> };
  return { index, rowId: row.id, toolCallId: admittedCall.id, toolName: admittedCall.name, arguments: admittedCall.arguments };
}

function directResult(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.type !== "message" || !isRecord(row.message)) return null;
  const message = row.message;
  if (message.role !== "toolResult" || typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) return null;
  if (!hasExactKeys(row, ["type", "id", "parentId", "timestamp", "message"]) ||
      !hasExactKeys(message, ["role", "toolCallId", "toolName", "content", "isError", "details"], ["timestamp", "usage"]) ||
      typeof message.toolCallId !== "string" || !message.toolCallId ||
      (Object.hasOwn(message, "timestamp") && typeof message.timestamp !== "number")) invalid();
  return message;
}

/** Streaming reducer for the direct package lifecycle. Rejected payloads are discarded as each pair closes. */
export class AcceptanceCollector {
  #pendingIssuance: DirectIssuance | null = null;
  #acceptedPair: AcceptedPair | null = null;
  readonly #usedCallIds = new Set<string>();
  #sawPackageLifecycle = false;

  accept(value: unknown, index: number): void {
    if (!isRecord(value)) return;
    const issuance = directIssuance(value, index);
    const resultMessage = directResult(value);
    if (!issuance && !resultMessage) return;
    this.#sawPackageLifecycle = true;

    if (issuance) {
      if (this.#pendingIssuance || this.#usedCallIds.has(issuance.toolCallId)) invalid();
      this.#pendingIssuance = issuance;
      return;
    }

    const pending = this.#pendingIssuance;
    if (!pending || index !== pending.index + 1 || value.parentId !== pending.rowId ||
        resultMessage!.toolCallId !== pending.toolCallId || resultMessage!.toolName !== pending.toolName) {
      throw new RecorderError("acceptance-invalid");
    }
    this.#usedCallIds.add(pending.toolCallId);
    this.#pendingIssuance = null;

    if (resultMessage!.isError === true) return;
    if (resultMessage!.isError !== false || this.#acceptedPair) invalid();
    this.#acceptedPair = { issuance: pending, resultIndex: index, resultMessage: resultMessage! };
  }

  finish(rowCount: number): ExtractionResult {
    if (this.#pendingIssuance) invalid();
    if (!this.#acceptedPair) {
      if (this.#sawPackageLifecycle) throw new RecorderError("acceptance-missing");
      throw new RecorderError("acceptance-missing");
    }
    if (this.#acceptedPair.resultIndex !== rowCount - 1 || this.#acceptedPair.issuance.index !== rowCount - 2) invalid();
    return finalizeAcceptedPair(this.#acceptedPair);
  }
}

function finalizeAcceptedPair(pair: AcceptedPair): ExtractionResult {
  const { issuance, resultMessage } = pair;
  const content = resultMessage.content;
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0]) ||
      !hasExactKeys(content[0], ["type", "text"]) || content[0].type !== "text" || typeof content[0].text !== "string") invalid();

  const detailsMatch = issuance.toolName === COLLECTOR_OUTPUT_TOOL
    ? collectorProjection(issuance.arguments, resultMessage.details)
    : deepEqual(issuance.arguments, resultMessage.details);
  if (!detailsMatch) invalid();

  let details: AcceptedDetails;
  try {
    details = validateAcceptedDetails(issuance.toolName, resultMessage.details);
  } catch {
    throw new RecorderError("acceptance-invalid");
  }

  const accepted = { toolName: issuance.toolName, toolCallId: issuance.toolCallId, details };
  const scanned = scanJsonValue(accepted, "receipt") as { value: typeof accepted; report: ScanReport };
  try {
    validateAcceptedDetails(issuance.toolName, scanned.value.details);
  } catch {
    throw new RecorderError("scan-failed");
  }

  const receipt: AcceptedReceipt = { ...scanned.value, kind: receiptKind(issuance.toolName) };
  let auditObservation: AuditObservation | null = null;
  let report = scanned.report;
  if (carriesPackageAuditObservation(issuance.toolName)) {
    const usage = usageOf(resultMessage.usage);
    auditObservation = { toolName: issuance.toolName, toolCallId: issuance.toolCallId, auditPassed: true, ...(usage ? { usage } : {}) } as AuditObservation;
    if (usage) report = combineReports(report, scanJsonValue(usage, "audit.usage").report);
  }
  return {
    receipt,
    auditObservation,
    artifactKind: JSON.stringify(accepted) === JSON.stringify(scanned.value) ? "acceptedReceipt" : "sanitizedDerivativeOfAcceptedReceipt",
    report: report ?? emptyReport,
  };
}
