import {
  acceptedTextFor,
  carriesPackageAuditObservation,
  COLLECTOR_OUTPUT_TOOL,
  CODER_OUTPUT_TOOL_NAME,
  deepEqual,
  FIXER_OUTPUT_TOOL_NAME,
  isTerminatingToolName,
  JUDGE_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  TERMINATING_TOOL_NAMES,
  validateAcceptedDetails,
  type AcceptedDetails,
  type CollectorReceipt,
  type JudgeVerdict,
  type ReviewerOutput,
  type TerminatingToolName,
  type WorkerOutput,
} from "../package-contracts/terminating-tools.ts";
import { RecorderError } from "./errors.ts";
import {
  combineReports,
  scanJsonValue,
  type ScanReport,
} from "./scanner.ts";

export { TERMINATING_TOOL_NAMES };
export type { TerminatingToolName };

export type AcceptedReceipt =
  | {
    toolName: typeof CODER_OUTPUT_TOOL_NAME | typeof FIXER_OUTPUT_TOOL_NAME;
    toolCallId: string;
    details: WorkerOutput;
    kind: "worker";
  }
  | {
    toolName: typeof REVIEWER_OUTPUT_TOOL_NAME;
    toolCallId: string;
    details: ReviewerOutput;
    kind: "reviewer";
  }
  | {
    toolName: typeof JUDGE_OUTPUT_TOOL_NAME;
    toolCallId: string;
    details: JudgeVerdict;
    kind: "judge";
  }
  | {
    toolName: typeof COLLECTOR_OUTPUT_TOOL;
    toolCallId: string;
    details: CollectorReceipt;
    kind: "collector";
  };

export type AuditObservation = {
  toolName: typeof JUDGE_OUTPUT_TOOL_NAME | typeof REVIEWER_OUTPUT_TOOL_NAME;
  toolCallId: string;
  auditPassed: true;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
};

export type ExtractionResult = {
  receipt: AcceptedReceipt | null;
  /** Present only when an accepted Judge/Reviewer lifecycle carried bound audit facts. */
  auditObservation: AuditObservation | null;
  artifactKind: "acceptedReceipt" | "sanitizedDerivativeOfAcceptedReceipt" | null;
  report: ScanReport;
};

type LifecycleEvent =
  | {
    kind: "issued";
    index: number;
    toolCallId: string;
    toolName: TerminatingToolName;
    args: unknown;
  }
  | {
    kind: "start";
    index: number;
    toolCallId: string;
    toolName: TerminatingToolName;
    args: unknown;
  }
  | {
    kind: "terminal";
    index: number;
    toolCallId: string;
    toolName: TerminatingToolName;
    isError: boolean;
    contentText: string;
    details: unknown;
    usage: unknown;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentTextFromUnknown(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

/** Parse only supported persisted-session and machine/JSON envelopes into ordered rows. */
export function decodeEnvelopeRows(text: string): unknown[] {
  const rows: unknown[] = [];
  const lines = text.split(/\r?\n/);
  let sawLineJson = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      sawLineJson = true;
      if (Array.isArray(parsed)) {
        for (const item of parsed) rows.push(item);
      } else {
        rows.push(parsed);
      }
    } catch {
      // prose / unsupported line
    }
  }
  if (!sawLineJson) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        // Nested common containers for whole-document session objects only.
        if (isRecord(parsed)) {
          if (Array.isArray(parsed.messages)) return parsed.messages;
          if (Array.isArray(parsed.entries)) return parsed.entries;
          return [parsed];
        }
      } catch {
        return [];
      }
    }
  }
  return rows;
}

/**
 * Collect lifecycle-relevant events from supported envelope rows only.
 * Bare toolResult objects and recursive descent forgeries are ignored.
 */
export function collectLifecycleEvents(rows: unknown[]): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isRecord(row)) continue;

    // machine: tool_execution_start
    if (
      row.type === "tool_execution_start" &&
      typeof row.toolCallId === "string" &&
      row.toolCallId.length > 0 &&
      typeof row.toolName === "string" &&
      isTerminatingToolName(row.toolName)
    ) {
      events.push({
        kind: "start",
        index,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        args: row.args,
      });
      continue;
    }

    // machine: tool_execution_end
    if (
      row.type === "tool_execution_end" &&
      typeof row.toolCallId === "string" &&
      row.toolCallId.length > 0 &&
      typeof row.toolName === "string" &&
      isTerminatingToolName(row.toolName) &&
      typeof row.isError === "boolean"
    ) {
      const result = isRecord(row.result) ? row.result : null;
      events.push({
        kind: "terminal",
        index,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        isError: row.isError,
        contentText: contentTextFromUnknown(result?.content),
        details: result?.details,
        usage: result?.usage ?? row.usage,
      });
      continue;
    }

    // session JSONL: { type: "message", message }
    // machine/JSON: { type: "message_end", message }
    if (
      (row.type === "message" || row.type === "message_end") &&
      isRecord(row.message)
    ) {
      const message = row.message;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            !isRecord(part) ||
            part.type !== "toolCall" ||
            typeof part.name !== "string" ||
            !isTerminatingToolName(part.name) ||
            typeof part.id !== "string" ||
            part.id.length === 0
          ) {
            continue;
          }
          events.push({
            kind: "issued",
            index,
            toolCallId: part.id,
            toolName: part.name,
            args: part.arguments,
          });
        }
        continue;
      }
      if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        message.toolCallId.length > 0 &&
        typeof message.toolName === "string" &&
        isTerminatingToolName(message.toolName) &&
        typeof message.isError === "boolean"
      ) {
        events.push({
          kind: "terminal",
          index,
          toolCallId: message.toolCallId,
          toolName: message.toolName as TerminatingToolName,
          isError: message.isError,
          contentText: contentTextFromUnknown(message.content),
          details: message.details,
          usage: message.usage,
        });
      }
    }
  }
  return events;
}

/** @deprecated Use decodeEnvelopeRows + collectLifecycleEvents. Kept for tests naming. */
export function decodeToolResultsFromEnvelope(text: string): Array<{
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  details?: unknown;
  usage?: unknown;
}> {
  const events = collectLifecycleEvents(decodeEnvelopeRows(text));
  return events
    .filter((event): event is Extract<LifecycleEvent, { kind: "terminal" }> =>
      event.kind === "terminal"
    )
    .map((event) => ({
      role: "toolResult" as const,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      details: event.details,
      usage: event.usage,
    }));
}

type BoundAcceptance = {
  toolName: TerminatingToolName;
  toolCallId: string;
  details: AcceptedDetails;
  usage: unknown;
};

/**
 * Bind exactly one unambiguous production-accepted lifecycle across ordered events.
 * Law: issuance → matching start → exactly one matching successful terminal.
 * Absence is lawful (null). Multiple complete acceptances fail closed via throw.
 * Contaminated / forged / partial lifecycles never accept.
 */
export function bindAcceptedLifecycle(
  events: LifecycleEvent[],
): BoundAcceptance | null {
  type Phase = "none" | "issued" | "started" | "terminated" | "rejected";
  type State = {
    phase: Phase;
    toolName?: TerminatingToolName;
    issuedArgs?: unknown;
    issuedIndex?: number;
    startIndex?: number;
    acceptance?: BoundAcceptance;
  };

  const states = new Map<string, State>();
  const stateOf = (id: string): State => {
    const existing = states.get(id);
    if (existing) return existing;
    const created: State = { phase: "none" };
    states.set(id, created);
    return created;
  };
  const reject = (state: State): void => {
    state.phase = "rejected";
    delete state.acceptance;
  };

  for (const event of events) {
    const state = stateOf(event.toolCallId);
    if (state.phase === "rejected") continue;

    if (event.kind === "issued") {
      // Duplicate issuance / post-start issuance contaminates the lifecycle.
      if (state.phase !== "none") {
        reject(state);
        continue;
      }
      state.phase = "issued";
      state.toolName = event.toolName;
      state.issuedArgs = event.args;
      state.issuedIndex = event.index;
      continue;
    }

    if (event.kind === "start") {
      if (
        state.phase !== "issued" ||
        state.toolName !== event.toolName ||
        state.issuedIndex === undefined ||
        !(state.issuedIndex < event.index) ||
        !deepEqual(state.issuedArgs, event.args)
      ) {
        reject(state);
        continue;
      }
      state.phase = "started";
      state.startIndex = event.index;
      continue;
    }

    // terminal — require exactly one success after start; any further terminal rejects.
    if (
      state.phase !== "started" ||
      state.toolName !== event.toolName ||
      state.startIndex === undefined ||
      !(state.startIndex < event.index)
    ) {
      reject(state);
      continue;
    }
    if (event.isError) {
      reject(state);
      continue;
    }
    const expectedText = acceptedTextFor(event.toolName);
    // Exact package-owned acceptance text only; prefixes/suffixes/embeddings fail.
    if (event.contentText !== expectedText) {
      reject(state);
      continue;
    }
    // Non-collector: terminal details must equal issued args.
    // Collector: issued args are generated legs-only; terminal details are full receipt.
    if (
      event.toolName !== COLLECTOR_OUTPUT_TOOL &&
      !deepEqual(event.details, state.issuedArgs)
    ) {
      reject(state);
      continue;
    }

    let details: AcceptedDetails;
    try {
      details = validateAcceptedDetails(event.toolName, event.details);
    } catch {
      reject(state);
      continue;
    }

    state.phase = "terminated";
    state.acceptance = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      details,
      usage: event.usage,
    };
  }

  const accepted: BoundAcceptance[] = [];
  for (const state of states.values()) {
    if (state.phase === "terminated" && state.acceptance !== undefined) {
      accepted.push(state.acceptance);
    }
  }

  if (accepted.length === 0) return null;
  if (accepted.length > 1) {
    // Ambiguous multiple distinct package acceptances — fail closed.
    throw new RecorderError(
      "extraction-failed",
      "multiple unambiguous package acceptances are conflicting",
    );
  }
  return accepted[0]!;
}

function toAcceptedReceipt(
  toolName: TerminatingToolName,
  toolCallId: string,
  details: AcceptedDetails,
): AcceptedReceipt {
  switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME:
    case FIXER_OUTPUT_TOOL_NAME:
      return {
        toolName,
        toolCallId,
        details: details as WorkerOutput,
        kind: "worker",
      };
    case REVIEWER_OUTPUT_TOOL_NAME:
      return {
        toolName,
        toolCallId,
        details: details as ReviewerOutput,
        kind: "reviewer",
      };
    case JUDGE_OUTPUT_TOOL_NAME:
      return {
        toolName,
        toolCallId,
        details: details as JudgeVerdict,
        kind: "judge",
      };
    case COLLECTOR_OUTPUT_TOOL:
      return {
        toolName,
        toolCallId,
        details: details as CollectorReceipt,
        kind: "collector",
      };
  }
}

function usageObservation(
  usage: unknown,
): NonNullable<AuditObservation["usage"]> | undefined {
  if (!isRecord(usage)) return undefined;
  const out: NonNullable<AuditObservation["usage"]> = {};
  if (typeof usage.input === "number") out.input = usage.input;
  if (typeof usage.output === "number") out.output = usage.output;
  if (typeof usage.cacheRead === "number") out.cacheRead = usage.cacheRead;
  if (typeof usage.cacheWrite === "number") out.cacheWrite = usage.cacheWrite;
  if (typeof usage.totalTokens === "number") out.totalTokens = usage.totalTokens;
  return Object.keys(out).length === 0 ? undefined : out;
}

export function extractAcceptedReceipt(
  envelopes: string[],
): ExtractionResult {
  const emptyReport: ScanReport = { hits: [], redacted: false };
  const rows: unknown[] = [];
  for (const text of envelopes) {
    rows.push(...decodeEnvelopeRows(text));
  }
  const events = collectLifecycleEvents(rows);
  let bound: BoundAcceptance | null;
  try {
    bound = bindAcceptedLifecycle(events);
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError(
      "extraction-failed",
      "receipt extraction failed",
      { cause: error },
    );
  }

  if (bound === null) {
    return {
      receipt: null,
      auditObservation: null,
      artifactKind: null,
      report: emptyReport,
    };
  }

  const originalJson = JSON.stringify(bound.details);
  const scanned = scanJsonValue(bound.details, "receipt.details");
  const scannedJson = JSON.stringify(scanned.value);

  // Revalidate derivative; redaction that damages discriminant/type fails closed.
  try {
    validateAcceptedDetails(bound.toolName, scanned.value);
  } catch {
    throw new RecorderError(
      "scan-failed",
      "redaction made accepted receipt production-unlawful",
    );
  }

  // Key collision: if scan produced colliding keys under an object, scanner throws.
  const receipt = toAcceptedReceipt(
    bound.toolName,
    bound.toolCallId,
    scanned.value as AcceptedDetails,
  );

  const artifactKind = originalJson === scannedJson
    ? "acceptedReceipt"
    : "sanitizedDerivativeOfAcceptedReceipt";

  let auditObservation: AuditObservation | null = null;
  // Audit only from genuinely bound accepted Judge/Reviewer lifecycle.
  // Never infer auditPassed from tool identity alone or child exit success.
  if (carriesPackageAuditObservation(bound.toolName)) {
    const usage = usageObservation(bound.usage);
    let usageScan = emptyReport;
    let scannedUsage: AuditObservation["usage"] | undefined;
    if (usage !== undefined) {
      const usageResult = scanJsonValue(usage, "audit.usage");
      usageScan = usageResult.report;
      scannedUsage = usageResult.value as AuditObservation["usage"];
    }
    auditObservation = {
      toolName: bound.toolName as AuditObservation["toolName"],
      toolCallId: bound.toolCallId,
      auditPassed: true,
      ...(scannedUsage === undefined ? {} : { usage: scannedUsage }),
    };
    return {
      receipt,
      auditObservation,
      artifactKind,
      report: combineReports(scanned.report, usageScan),
    };
  }

  return {
    receipt,
    auditObservation,
    artifactKind,
    report: scanned.report,
  };
}
